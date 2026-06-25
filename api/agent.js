export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const CLIENT_ID = process.env.ZOHO_CLIENT_ID;
  const CLIENT_SECRET = process.env.ZOHO_CLIENT_SECRET;
  const REFRESH_TOKEN = process.env.ZOHO_REFRESH_TOKEN;
  const ORG = '60013876707';
  const ETA_SHEET = '5gpr0ec9c44d4fc244e3384e014ed77bb5aae';

  try {
    // Get fresh access token
    const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        refresh_token: REFRESH_TOKEN,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'refresh_token'
      })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) {
      return res.status(401).json({ error: `Token refresh failed: ${JSON.stringify(tokenData)}` });
    }

    const AT = tokenData.access_token;
    const zH = { 'Authorization': `Zoho-oauthtoken ${AT}` };
    const BASE = 'https://books.zoho.in/api/v3';

    // Fetch all data in parallel
    const [soRes, unpRes, parRes] = await Promise.all([
      fetch(`${BASE}/salesorders?filter_by=Status.Open&per_page=200&organization_id=${ORG}`, { headers: zH }),
      fetch(`${BASE}/invoices?status=unpaid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH }),
      fetch(`${BASE}/invoices?status=partially_paid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH })
    ]);

    const [soData, unpData, parData] = await Promise.all([soRes.json(), unpRes.json(), parRes.json()]);

    // Fetch ETA sheet
    let etaMap = {};
    try {
      const sheetRes = await fetch(
        `https://sheet.zoho.in/api/v2/${ETA_SHEET}?method=worksheet.records.fetch&worksheet_name=Sheet1&header_row=1`,
        { headers: zH }
      );
      const sheetData = await sheetRes.json();
      const rows = sheetData?.records?.rows || [];
      rows.forEach(row => {
        const sku = String(row.SKU||'').trim();
        const eta = String(row.ETA||'').trim();
        if (sku && eta) etaMap[sku] = eta;
      });
    } catch(e) { /* ETA sheet optional */ }

    const salesorders = soData.salesorders || [];
    const unpaid = unpData.invoices || [];
    const partial = parData.invoices || [];
    const today = new Date(); today.setHours(0,0,0,0);

    // Filter confirmed SOs
    const confirmedSOs = salesorders.filter(so =>
      ['cs_preorde','cs_website','cs_verifie','open'].includes(so.current_sub_status)
    );

    // Filter BFLD invoices not shipped
    const invMap = {};
    [...unpaid, ...partial].forEach(inv => {
      const num = inv.invoice_number || '';
      const cf = inv.custom_field_hash || {};
      if ((num.startsWith('BFLD') || num.startsWith('BF')) &&
          String(cf.cf_shipped||'').toLowerCase() !== 'yes' &&
          !invMap[inv.invoice_id]) {
        invMap[inv.invoice_id] = inv;
      }
    });
    const bfld = Object.values(invMap);

    // Fetch full details for top 20 SOs and top 30 BFLD invoices (for line items)
    const topSOs = confirmedSOs.slice(0, 20);
    const topBFLD = bfld.slice(0, 30);

    const soDetails = await Promise.all(
      topSOs.map(so =>
        fetch(`${BASE}/salesorders/${so.salesorder_id}?organization_id=${ORG}`, { headers: zH })
          .then(r => r.json()).then(d => d.salesorder || null).catch(() => null)
      )
    );

    const invDetails = await Promise.all(
      topBFLD.map(inv =>
        fetch(`${BASE}/invoices/${inv.invoice_id}?organization_id=${ORG}`, { headers: zH })
          .then(r => r.json()).then(d => d.invoice || null).catch(() => null)
      )
    );

    function days(s) {
      if (!s) return null;
      try { const d = new Date(s); d.setHours(0,0,0,0); return Math.ceil((d-today)/86400000); } catch(e) { return null; }
    }

    function getLineItems(lineItems, orderESD) {
      if (!lineItems || !lineItems.length) return [];
      const esdDays = days(orderESD);

      // Build FAP pool per SKU from BFLD
      const fapBySku = {};
      bfld.forEach(inv => {
        const total = parseFloat(inv.total)||0;
        const bal = parseFloat(inv.balance)||0;
        const adv = total > 0 ? Math.round(((total-bal)/total)*100) : 0;
        const invEsdDays = days(inv.due_date);
        if (adv < 30 && invEsdDays !== null && invEsdDays > 30) {
          // This invoice is a FAP candidate — but we don't have its line items here
          // Mark the invoice as potential FAP
        }
      });

      return lineItems
        .filter(li => li.item_type !== 'service' && !li.name?.toLowerCase().includes('install'))
        .map(li => {
          const sku = String(li.sku||li.item_id||'').trim();
          const name = li.name || li.item_name || '';
          const qty = parseFloat(li.quantity)||1;
          const eta = etaMap[sku] || null;
          const etaDays = eta ? days(eta.includes('/')?eta.split('/').reverse().join('-'):eta) : null;

          let status = 'stock', statusLabel = 'In stock', detail = '';

          // SOH check — use quantity_packed as proxy
          const packed = parseFloat(li.quantity_packed)||0;
          if (packed >= qty) {
            status = 'stock'; statusLabel = 'In stock / packed';
          } else if (eta) {
            // Check if ETA is before or after order ESD
            if (etaDays !== null && esdDays !== null && etaDays <= esdDays) {
              status = 'eta'; statusLabel = `On ETA ${eta}`;
              detail = `Stock arriving ${eta} — before order ESD ${orderESD}`;
            } else if (etaDays !== null && etaDays > 30) {
              // Check FAP — find BFLD invoices with same SKU, low advance, far ESD
              const fapCandidates = bfld.filter(inv => {
                const invTotal = parseFloat(inv.total)||0;
                const invBal = parseFloat(inv.balance)||0;
                const invAdv = invTotal > 0 ? Math.round(((invTotal-invBal)/invTotal)*100) : 0;
                const invEsdDays = days(inv.due_date);
                return invAdv < 30 && invEsdDays !== null && invEsdDays > (etaDays||30);
              }).slice(0, 2);

              if (fapCandidates.length > 0) {
                status = 'fap';
                statusLabel = 'FAP possible';
                detail = fapCandidates.map(c => {
                  const invTotal = parseFloat(c.total)||0;
                  const invBal = parseFloat(c.balance)||0;
                  const invAdv = invTotal > 0 ? Math.round(((invTotal-invBal)/invTotal)*100) : 0;
                  return `${c.invoice_number} (${c.customer_name}, ${invAdv}% adv, ESD ${c.due_date}) — can reallocate SKU ${sku}`;
                }).join(' | ');
              } else {
                status = 'eta'; statusLabel = `On ETA ${eta}`;
                detail = `ETA ${eta} is after order ESD — no FAP candidate found`;
              }
            } else {
              status = 'eta'; statusLabel = `On ETA ${eta}`;
            }
          } else {
            status = 'blocked'; statusLabel = 'Not in ETA sheet';
            detail = `SKU ${sku} not found in ETA sheet — raise import/purchase order`;
          }

          return { sku: sku||'—', name, qty, status, statusLabel, detail };
        });
    }

    function classifyOrder(ref, cust, sp, esd, confirmed, total, bal, note, sub, id, type, lineItems) {
      const d = days(esd);
      const age = confirmed ? Math.ceil((today - new Date(confirmed)) / 86400000) : 0;
      const adv = total > 0 ? Math.round(((total-bal)/total)*100) : 0;
      let effAdv = adv, unrecorded = false;
      if (note && adv === 0) {
        const pct = note.match(/(\d+)\s*%/);
        const amt = note.match(/(\d[\d,]+)/);
        if (pct) { effAdv = parseInt(pct[1]); unrecorded = true; }
        else if (amt && total > 0) { effAdv = Math.round((parseInt(amt[1].replace(/,/g,''))/total)*100); unrecorded = true; }
      }

      const processedLines = lineItems ? getLineItems(lineItems, esd) : [];
      const hasBlocked = processedLines.some(l => l.status === 'blocked');
      const hasFAP = processedLines.some(l => l.status === 'fap');
      const hasETA = processedLines.some(l => l.status === 'eta');
      const allStock = processedLines.length > 0 && processedLines.every(l => l.status === 'stock');

      let verdict = 'fulfillable', vl = 'Ready to dispatch', action = 'Book shipping now';
      if (sub?.includes('Cancelled')) { verdict='urgent'; vl='Cancelled — review'; action='Decide: refund or dispatch'; }
      else if (d !== null && d < 0) { verdict='urgent'; vl=`${Math.abs(d)}d lapsed`; action='Contact customer immediately'; }
      else if (hasFAP) { verdict='fap'; vl='FAP reallocation possible'; action='Reallocate stock from FAP order — see line items'; }
      else if (hasBlocked) { verdict='blocked'; vl='Item not in ETA sheet'; action='Raise import/purchase order for missing SKU'; }
      else if (hasETA) { verdict='eta'; vl='Awaiting stock arrival'; action='Dispatch when ETA stock arrives'; }
      else if (allStock || processedLines.length === 0) {
        if (effAdv < 30 && d !== null && d > 30) { verdict='fap'; vl='FAP candidate (low advance)'; action='Low advance — can reallocate if urgent buyer'; }
        else if (effAdv < 30 && age > 7 && !note) { verdict='blocked'; vl='No payment'; action='Collect advance or dissolve'; }
      }

      const acct = unrecorded ? `Payment ~${effAdv}% received but NOT recorded in Zoho — record now` :
        (age > 7 && effAdv < 30 && !note) ? `${age}d old, ${effAdv}% advance — collect or dissolve` : '';

      return {
        ref, customer: cust||'', salesperson: sp||'',
        esd: esd||'', daysToEsd: d,
        confirmedDate: confirmed||'', bookingAgeDays: age,
        total: Math.round(total), balance: Math.round(bal),
        advancePct: adv, effectiveAdvPct: effAdv,
        paymentNote: note||'', paymentUnrecorded: unrecorded,
        subStatus: sub||'Confirmed',
        verdict, verdictLabel: vl, action,
        zohoUrl: type==='so'
          ? `https://books.zoho.in/app/${ORG}#/salesorders/${id}`
          : `https://books.zoho.in/app/${ORG}#/invoices/${id}`,
        lineItems: processedLines.length > 0 ? processedLines : [{ sku:'—', name:'Fetch full details — click Open in Zoho', qty:1, status:'stock', statusLabel:'See Zoho', detail:'' }],
        accountsAlert: acct
      };
    }

    const orders = [];

    // Process SOs with full details
    soDetails.forEach((detail, i) => {
      const so = detail || topSOs[i];
      orders.push(classifyOrder(
        so.salesorder_number, so.customer_name, so.salesperson_name,
        so.shipment_date, so.cf_confirmed_date_unformatted||so.date,
        parseFloat(so.total)||0, parseFloat(so.balance)||0,
        so.custom_field_hash?.cf_payment_note||'',
        so.current_sub_status, so.salesorder_id, 'so',
        so.line_items||null
      ));
    });

    // Process remaining SOs without line items
    confirmedSOs.slice(20).forEach(so => {
      orders.push(classifyOrder(
        so.salesorder_number, so.customer_name, so.salesperson_name,
        so.shipment_date, so.cf_confirmed_date_unformatted||so.date,
        parseFloat(so.total)||0, parseFloat(so.balance)||0,
        so.custom_field_hash?.cf_payment_note||'',
        so.current_sub_status, so.salesorder_id, 'so', null
      ));
    });

    // Process BFLD with full details
    invDetails.forEach((detail, i) => {
      const inv = detail || topBFLD[i];
      orders.push(classifyOrder(
        inv.invoice_number, inv.customer_name, inv.salesperson_name,
        inv.due_date||inv.custom_field_hash?.cf_expected_shipment_date||'',
        inv.date, parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
        '', inv.status, inv.invoice_id, 'inv',
        inv.line_items||null
      ));
    });

    // Remaining BFLD without line items
    bfld.slice(30).forEach(inv => {
      orders.push(classifyOrder(
        inv.invoice_number, inv.customer_name, inv.salesperson_name,
        inv.due_date||'', inv.date,
        parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
        '', inv.status, inv.invoice_id, 'inv', null
      ));
    });

    orders.sort((a,b) => {
      if (a.verdict==='urgent'&&b.verdict!=='urgent') return -1;
      if (b.verdict==='urgent'&&a.verdict!=='urgent') return 1;
      if (a.verdict==='fap'&&b.verdict!=='fap') return -1;
      if (b.verdict==='fap'&&a.verdict!=='fap') return 1;
      return a.effectiveAdvPct - b.effectiveAdvPct;
    });

    const fapOrders = orders.filter(o=>o.verdict==='fap');
    const result = {
      type: 'full_report',
      stats: {
        total: orders.length,
        fulfillable: orders.filter(o=>o.verdict==='fulfillable').length,
        fap: fapOrders.length,
        eta: orders.filter(o=>o.verdict==='eta').length,
        blocked: orders.filter(o=>o.verdict==='blocked').length,
        cashAtRisk: orders.filter(o=>o.effectiveAdvPct<30&&o.bookingAgeDays>7).reduce((s,o)=>s+o.balance,0),
        fapValue: fapOrders.reduce((s,o)=>s+o.balance,0),
        etaSkus: Object.keys(etaMap).length
      },
      orders,
      accountsAlerts: orders.filter(o=>o.accountsAlert).map(o=>({
        ref:o.ref, customer:o.customer, salesperson:o.salesperson,
        bookingAgeDays:o.bookingAgeDays, advancePct:o.advancePct,
        issue:o.accountsAlert,
        action:o.paymentUnrecorded?'record':o.subStatus?.includes('Cancelled')?'review':o.bookingAgeDays>30?'dissolve':'collect'
      }))
    };

    return res.status(200).json({ success: true, data: result });
  } catch(e) {
    return res.status(500).json({ error: e.message, stack: e.stack?.substring(0,500) });
  }
}
