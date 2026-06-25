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

    // Fetch Zoho Books data + ETA sheet in parallel
    const [soRes, unpRes, parRes, sheetRes] = await Promise.all([
      fetch(`${BASE}/salesorders?filter_by=Status.Open&per_page=200&organization_id=${ORG}`, { headers: zH }),
      fetch(`${BASE}/invoices?status=unpaid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH }),
      fetch(`${BASE}/invoices?status=partially_paid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH }),
      fetch(`https://sheet.zoho.in/api/v2/${ETA_SHEET}?method=worksheet.records.fetch&worksheet_name=Sheet1&header_row=1`, { headers: zH })
    ]);

    const [soData, unpData, parData] = await Promise.all([soRes.json(), unpRes.json(), parRes.json()]);

    // Build ETA map - multiple attempts to handle different response formats
    let etaMap = {};
    let etaDebug = 'not fetched';
    try {
      const sheetText = await sheetRes.text();
      const sheetData = JSON.parse(sheetText);
      etaDebug = `code:${sheetData.code} keys:${Object.keys(sheetData).join(',')}`;

      // Try different response structures
      const rows = sheetData?.records?.rows ||
                   sheetData?.rows ||
                   sheetData?.data?.rows ||
                   [];

      rows.forEach(row => {
        // Handle both object format and array format
        const rawSku = row.SKU || row.sku || row[0] || '';
        const rawEta = row.ETA || row.eta || row[3] || '';
        const sku = String(rawSku).trim().replace(/^0+/, ''); // remove leading zeros for flexible matching
        const skuPadded = String(rawSku).trim();
        const eta = String(rawEta).trim();
        if (sku && eta) {
          etaMap[sku] = eta;           // e.g. "1015" -> "09/07/2026"
          etaMap[skuPadded] = eta;     // e.g. "1015" -> "09/07/2026" (with original padding)
          // Also store with leading zeros up to 4 digits
          etaMap[sku.padStart(4,'0')] = eta;
        }
      });
      etaDebug += ` rows:${rows.length} etaKeys:${Object.keys(etaMap).length}`;
    } catch(e) {
      etaDebug = 'error: ' + e.message;
    }

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

    function days(s) {
      if (!s) return null;
      try {
        // Handle DD/MM/YYYY format from ETA sheet
        let dateStr = s;
        if (s.includes('/') && !s.includes('-')) {
          const parts = s.split('/');
          if (parts.length === 3) dateStr = `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;
        }
        const d = new Date(dateStr); d.setHours(0,0,0,0);
        if (isNaN(d.getTime())) return null;
        return Math.ceil((d-today)/86400000);
      } catch(e) { return null; }
    }

    function lookupETA(sku) {
      if (!sku) return null;
      const s = String(sku).trim();
      return etaMap[s] ||
             etaMap[s.replace(/^0+/,'')] ||
             etaMap[s.padStart(4,'0')] ||
             etaMap[s.padStart(5,'0')] ||
             null;
    }

    function getLineItems(lineItems, orderESD) {
      if (!lineItems || !lineItems.length) return [];
      const esdDays = days(orderESD);

      return lineItems
        .filter(li => (li.item_type || '') !== 'service' &&
                      !(li.name||'').toLowerCase().includes('install') &&
                      !(li.name||'').toLowerCase().includes('charges'))
        .map(li => {
          const sku = String(li.sku || li.item_id || '').trim();
          const name = li.name || li.item_name || '';
          const qty = parseFloat(li.quantity) || 1;
          const packed = parseFloat(li.quantity_packed) || 0;
          const eta = lookupETA(sku);
          const etaDays = eta ? days(eta) : null;

          let status = 'stock', statusLabel = 'In stock', detail = '';

          if (packed >= qty) {
            status = 'stock';
            statusLabel = 'Packed ✓';
            detail = '';
          } else if (eta) {
            if (etaDays !== null && esdDays !== null && etaDays <= esdDays) {
              // Stock arrives before ESD — fine
              status = 'eta';
              statusLabel = `On ETA ${eta}`;
              detail = `Arriving ${eta} — before order ESD`;
            } else {
              // Stock arrives AFTER ESD — check FAP
              const fapCandidates = bfld.filter(inv => {
                const t = parseFloat(inv.total)||0;
                const b = parseFloat(inv.balance)||0;
                const a = t > 0 ? Math.round(((t-b)/t)*100) : 0;
                const d2 = days(inv.due_date);
                return a < 30 && d2 !== null && d2 > (etaDays||30);
              }).slice(0,2);

              if (fapCandidates.length > 0) {
                status = 'fap';
                statusLabel = 'FAP possible';
                detail = 'ETA '+eta+' is after order ESD. Realloc from: ' +
                  fapCandidates.map(c => {
                    const t=parseFloat(c.total)||0, b=parseFloat(c.balance)||0;
                    const a=t>0?Math.round(((t-b)/t)*100):0;
                    return `${c.invoice_number} (${c.customer_name}, ${a}% adv, ESD ${c.due_date})`;
                  }).join(' | ');
              } else {
                status = 'eta';
                statusLabel = `ETA ${eta} (after ESD)`;
                detail = `ETA ${eta} is after order ESD — no FAP candidate with low advance found`;
              }
            }
          } else {
            status = 'blocked';
            statusLabel = 'Not in ETA sheet';
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

      const lines = lineItems ? getLineItems(lineItems, esd) : [];
      const hasBlocked = lines.some(l => l.status === 'blocked');
      const hasFAP = lines.some(l => l.status === 'fap');
      const hasETA = lines.some(l => l.status === 'eta');

      let verdict='fulfillable', vl='Ready to dispatch', action='Book shipping now';
      if (sub?.includes('Cancelled')) { verdict='urgent'; vl='Cancelled — review'; action='Decide: refund or dispatch'; }
      else if (d !== null && d < 0) { verdict='urgent'; vl=`${Math.abs(d)}d lapsed`; action='Contact customer immediately'; }
      else if (hasFAP) { verdict='fap'; vl='FAP reallocation possible'; action='See line items for FAP details'; }
      else if (hasBlocked) { verdict='blocked'; vl='Item not ordered'; action='Raise import for missing SKU'; }
      else if (hasETA) { verdict='eta'; vl='Awaiting ETA stock'; action='Dispatch when stock arrives'; }
      else if (effAdv < 30 && d !== null && d > 30 && lines.length === 0) { verdict='fap'; vl='FAP candidate (low advance)'; action='Low advance — reallocate if urgent buyer found'; }
      else if (effAdv < 30 && age > 7 && !note) { verdict='blocked'; vl='No payment'; action='Collect advance or dissolve'; }

      const acct = unrecorded ? `Payment ~${effAdv}% received but NOT recorded in Zoho` :
        (age > 7 && effAdv < 30 && !note) ? `${age}d old, ${effAdv}% advance — collect or dissolve` : '';

      return {
        ref, customer: cust||'', salesperson: sp||'',
        esd: esd||'', daysToEsd: d,
        confirmedDate: confirmed||'', bookingAgeDays: age,
        total: Math.round(total), balance: Math.round(bal),
        advancePct: adv, effectiveAdvPct: effAdv,
        paymentNote: note||'', paymentUnrecorded: unrecorded,
        subStatus: sub||'Confirmed', verdict, verdictLabel: vl, action,
        zohoUrl: type==='so'
          ? `https://books.zoho.in/app/${ORG}#/salesorders/${id}`
          : `https://books.zoho.in/app/${ORG}#/invoices/${id}`,
        lineItems: lines,
        accountsAlert: acct
      };
    }

    // Route specific queries
    const msgLower = (req.body.message || '').toLowerCase();
    const checkMatch = msgLower.match(/check\s+(so-\d+|bfld[-\d]+|bf\d+)/i) ||
                       (req.body.message||'').match(/check\s+(SO-\d+|BFLD[-\d]+|BF[\d-]+)/i);
    const skuMatch = msgLower.match(/fap for sku\s+([^\s]+)/i) ||
                     msgLower.match(/sku\s+([^\s]+)/i);

    const orders = [];

    // Fetch ALL SO details with line items
    const soDetailResults = await Promise.all(
      confirmedSOs.map(so =>
        fetch(`${BASE}/salesorders/${so.salesorder_id}?organization_id=${ORG}`, { headers: zH })
          .then(r => r.json()).then(d => d.salesorder || null).catch(() => null)
      )
    );

    soDetailResults.forEach((detail, i) => {
      const so = detail || confirmedSOs[i];
      orders.push(classifyOrder(
        so.salesorder_number, so.customer_name, so.salesperson_name,
        so.shipment_date, so.cf_confirmed_date_unformatted||so.date,
        parseFloat(so.total)||0, parseFloat(so.balance)||0,
        so.custom_field_hash?.cf_payment_note||'',
        so.current_sub_status, so.salesorder_id, 'so', so.line_items||[]
      ));
    });

    // Fetch ALL BFLD details with line items
    const invDetailResults = await Promise.all(
      bfld.map(inv =>
        fetch(`${BASE}/invoices/${inv.invoice_id}?organization_id=${ORG}`, { headers: zH })
          .then(r => r.json()).then(d => d.invoice || null).catch(() => null)
      )
    );

    invDetailResults.forEach((detail, i) => {
      const inv = detail || bfld[i];
      orders.push(classifyOrder(
        inv.invoice_number, inv.customer_name, inv.salesperson_name,
        inv.due_date||inv.custom_field_hash?.cf_expected_shipment_date||'',
        inv.date, parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
        '', inv.status, inv.invoice_id, 'inv', inv.line_items||[]
      ));
    });

    orders.sort((a,b) => {
      const vOrder = {urgent:0,fap:1,blocked:2,eta:3,fulfillable:4};
      if ((vOrder[a.verdict]||5) !== (vOrder[b.verdict]||5)) return (vOrder[a.verdict]||5)-(vOrder[b.verdict]||5);
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
        etaSheetLoaded: Object.keys(etaMap).length,
        etaDebug
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
    return res.status(500).json({ error: e.message, stack: e.stack?.substring(0,300) });
  }
}
