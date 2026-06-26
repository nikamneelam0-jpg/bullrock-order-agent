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
  const BASE = 'https://books.zoho.in/api/v3';
  const today = new Date(); today.setHours(0,0,0,0);

  try {
    // Step 1: Get access token
    const tokenRes = await fetch('https://accounts.zoho.in/oauth/v2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ refresh_token: REFRESH_TOKEN, client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token' })
    });
    const tokenData = await tokenRes.json();
    if (!tokenData.access_token) return res.status(401).json({ error: 'Token refresh failed: ' + JSON.stringify(tokenData) });
    const AT = tokenData.access_token;
    const zH = { 'Authorization': 'Zoho-oauthtoken ' + AT };

    // Step 2: Fetch lists + ETA sheet in parallel
    const [soRes, unpRes, parRes, sheetRes] = await Promise.all([
      fetch(BASE + '/salesorders?filter_by=Status.Open&per_page=200&organization_id=' + ORG, { headers: zH }),
      fetch(BASE + '/invoices?status=unpaid&per_page=200&sort_column=due_date&organization_id=' + ORG, { headers: zH }),
      fetch(BASE + '/invoices?status=partially_paid&per_page=200&sort_column=due_date&organization_id=' + ORG, { headers: zH }),
      fetch('https://sheet.zoho.in/api/v2/' + ETA_SHEET + '?method=worksheet.records.fetch&worksheet_name=Sheet1&header_row=1', { headers: zH })
    ]);
    const [soData, unpData, parData] = await Promise.all([soRes.json(), unpRes.json(), parRes.json()]);

    // Step 3: Build ETA map — store every possible SKU format
    const etaMap = {};
    try {
      const sheetData = await sheetRes.json();
      const rows = sheetData?.records?.rows || [];
      rows.forEach(row => {
        const rawSku = String(row.SKU || row.sku || '').trim();
        const rawEta = String(row.ETA || row.eta || '').trim();
        if (rawSku && rawEta) {
          etaMap[rawSku] = rawEta;
          etaMap[rawSku.replace(/^0+/, '')] = rawEta;
          etaMap[rawSku.padStart(4, '0')] = rawEta;
          etaMap[rawSku.padStart(5, '0')] = rawEta;
        }
      });
    } catch(e) {}

    // Step 4: Filter confirmed SOs and unshipped BFLD invoices
    const confirmedSOs = (soData.salesorders || []).filter(so =>
      ['cs_preorde', 'cs_website', 'cs_verifie', 'open'].includes(so.current_sub_status)
    );
    const invMap = {};
    [...(unpData.invoices || []), ...(parData.invoices || [])].forEach(inv => {
      const num = inv.invoice_number || '';
      const cf = inv.custom_field_hash || {};
      if ((num.startsWith('BFLD') || num.startsWith('BF')) &&
          String(cf.cf_shipped || '').toLowerCase() !== 'yes' &&
          !invMap[inv.invoice_id]) {
        invMap[inv.invoice_id] = inv;
      }
    });
    const bfld = Object.values(invMap);

    // Step 5: Fetch full details (with line items) in batches of 5
    async function fetchDetails(items, urlFn) {
      const results = [];
      for (let i = 0; i < items.length; i += 5) {
        const batch = items.slice(i, i + 5);
        const batchResults = await Promise.all(
          batch.map(item => fetch(urlFn(item), { headers: zH })
            .then(r => r.json()).then(d => d.salesorder || d.invoice || null).catch(() => null))
        );
        results.push(...batchResults);
      }
      return results;
    }

    // Only fetch top 15 SOs and top 25 BFLD to stay within timeout
    const [soDetails, invDetails] = await Promise.all([
      fetchDetails(confirmedSOs.slice(0, 15), so => BASE + '/salesorders/' + so.salesorder_id + '?organization_id=' + ORG),
      fetchDetails(bfld.slice(0, 25), inv => BASE + '/invoices/' + inv.invoice_id + '?organization_id=' + ORG)
    ]);

    // Step 6: Helpers
    function days(s) {
      if (!s) return null;
      try {
        let d = s;
        if (s.includes('/') && !s.includes('-')) {
          const p = s.split('/');
          if (p.length === 3) d = p[2] + '-' + p[1].padStart(2,'0') + '-' + p[0].padStart(2,'0');
        }
        const dt = new Date(d); dt.setHours(0,0,0,0);
        return isNaN(dt.getTime()) ? null : Math.ceil((dt - today) / 86400000);
      } catch(e) { return null; }
    }

    function lookupETA(sku) {
      if (!sku) return null;
      const s = String(sku).trim();
      return etaMap[s] || etaMap[s.replace(/^0+/,'')] || etaMap[s.padStart(4,'0')] || etaMap[s.padStart(5,'0')] || null;
    }

    function processLineItems(lineItems, orderESD) {
      if (!lineItems || !lineItems.length) return [];
      const esdDays = days(orderESD);
      return lineItems
        .filter(li => li.item_type === 'inventory' && li.sku !== 'Installation_Charges')
        .map(li => {
          const sku = String(li.sku || '').trim();
          const name = li.name || '';
          const qty = parseFloat(li.quantity) || 1;
          // SOH is directly in line item response
          const soh = parseFloat(li.stock_on_hand) || 0;
          const eta = lookupETA(sku);
          const etaDays = days(eta);

          let status, statusLabel, detail;

          if (soh >= qty) {
            status = 'stock'; statusLabel = 'In stock'; detail = '';
          } else if (eta) {
            if (etaDays !== null && esdDays !== null && etaDays <= esdDays) {
              status = 'eta'; statusLabel = 'ETA ' + eta;
              detail = 'Stock arriving ' + eta + ' — before ESD ' + orderESD;
            } else {
              // ETA after ESD — look for FAP
              const fapCandidates = bfld.filter(inv => {
                const t = parseFloat(inv.total)||0, b = parseFloat(inv.balance)||0;
                const a = t > 0 ? Math.round(((t-b)/t)*100) : 0;
                const d2 = days(inv.due_date);
                return a < 30 && d2 !== null && d2 > 30 && inv.invoice_id !== (lineItems[0]?.invoice_id);
              }).slice(0, 2);

              if (fapCandidates.length > 0) {
                status = 'fap'; statusLabel = 'FAP possible';
                detail = 'ETA ' + eta + ' > ESD. Reallocate from: ' + fapCandidates.map(c => {
                  const t=parseFloat(c.total)||0, b=parseFloat(c.balance)||0;
                  const a=t>0?Math.round(((t-b)/t)*100):0;
                  return c.invoice_number + ' (' + c.customer_name + ', ' + a + '% adv, ESD ' + c.due_date + ')';
                }).join(' | ');
              } else {
                status = 'eta'; statusLabel = 'ETA ' + eta + ' (after ESD)';
                detail = 'ETA ' + eta + ' is after order ESD';
              }
            }
          } else {
            status = 'blocked'; statusLabel = 'Not in ETA sheet';
            detail = 'SKU ' + sku + ' not in ETA sheet — raise import/PO';
          }
          return { sku: sku || '—', name, qty, status, statusLabel, detail };
        });
    }

    function classify(ref, cust, sp, esd, confirmed, total, bal, note, sub, id, type, lineItems) {
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

      const lines = processLineItems(lineItems || [], esd);
      const hasFAP = lines.some(l => l.status === 'fap');
      const hasBlocked = lines.some(l => l.status === 'blocked');
      const hasETA = lines.some(l => l.status === 'eta');

      let verdict = 'fulfillable', vl = 'Ready', action = 'Book shipping';
      if (sub && sub.includes('Cancelled')) { verdict='urgent'; vl='Cancelled'; action='Refund or dispatch?'; }
      else if (d !== null && d < 0) { verdict='urgent'; vl=Math.abs(d)+'d lapsed'; action='Contact customer now'; }
      else if (hasFAP) { verdict='fap'; vl='FAP possible'; action='Reallocate — see line items'; }
      else if (hasBlocked) { verdict='blocked'; vl='Item not ordered'; action='Raise import for missing SKU'; }
      else if (hasETA) { verdict='eta'; vl='Awaiting ETA'; action='Dispatch when stock arrives'; }
      else if (effAdv < 30 && d !== null && d > 30 && lines.length === 0) { verdict='fap'; vl='FAP candidate'; action='Low advance — realloc possible'; }
      else if (effAdv < 30 && age > 7 && !note) { verdict='blocked'; vl='No payment'; action='Collect or dissolve'; }

      const acct = unrecorded ? 'Payment ~' + effAdv + '% received NOT recorded in Zoho' :
        (age > 7 && effAdv < 30 && !note) ? age + 'd old, ' + effAdv + '% adv — collect or dissolve' : '';

      return {
        ref, customer: cust||'', salesperson: sp||'',
        esd: esd||'', daysToEsd: d,
        confirmedDate: confirmed||'', bookingAgeDays: age,
        total: Math.round(total), balance: Math.round(bal),
        advancePct: adv, effectiveAdvPct: effAdv,
        paymentNote: note||'', paymentUnrecorded: unrecorded,
        subStatus: sub||'Confirmed', verdict, verdictLabel: vl, action,
        zohoUrl: type === 'so'
          ? 'https://books.zoho.in/app/' + ORG + '#/salesorders/' + id
          : 'https://books.zoho.in/app/' + ORG + '#/invoices/' + id,
        lineItems: lines,
        accountsAlert: acct
      };
    }

    const orders = [];

    // SOs with full line items
    soDetails.forEach((detail, i) => {
      const so = detail || confirmedSOs[i];
      if (!so) return;
      const cf = so.custom_field_hash || {};
      orders.push(classify(
        so.salesorder_number, so.customer_name, so.salesperson_name,
        so.shipment_date, cf.cf_confirmed_date_unformatted || so.date,
        parseFloat(so.total)||0, parseFloat(so.balance)||0,
        cf.cf_payment_note || '',
        so.current_sub_status, so.salesorder_id, 'so', so.line_items || []
      ));
    });
    // Remaining SOs without details
    confirmedSOs.slice(15).forEach(so => {
      const cf = so.custom_field_hash || {};
      orders.push(classify(so.salesorder_number, so.customer_name, so.salesperson_name,
        so.shipment_date, so.date, parseFloat(so.total)||0, parseFloat(so.balance)||0,
        cf.cf_payment_note||'', so.current_sub_status, so.salesorder_id, 'so', []));
    });

    // BFLD with full line items
    // KEY FIX: Use cf_expected_shipment_date_unformatted for ESD, not due_date
    invDetails.forEach((detail, i) => {
      const inv = detail || bfld[i];
      if (!inv) return;
      const cf = inv.custom_field_hash || {};
      const esd = cf.cf_expected_shipment_date_unformatted || inv.due_date || '';
      orders.push(classify(
        inv.invoice_number, inv.customer_name, inv.salesperson_name,
        esd, inv.date,
        parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
        '', inv.status, inv.invoice_id, 'inv', inv.line_items || []
      ));
    });
    // Remaining BFLD without details
    bfld.slice(25).forEach(inv => {
      const cf = inv.custom_field_hash || {};
      const esd = cf.cf_expected_shipment_date_unformatted || inv.due_date || '';
      orders.push(classify(inv.invoice_number, inv.customer_name, inv.salesperson_name,
        esd, inv.date, parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
        '', inv.status, inv.invoice_id, 'inv', []));
    });

    // Sort: urgent > fap > blocked > eta > fulfillable, then by advance %
    const vOrd = { urgent:0, fap:1, blocked:2, eta:3, fulfillable:4 };
    orders.sort((a,b) => {
      const va = vOrd[a.verdict]||5, vb = vOrd[b.verdict]||5;
      return va !== vb ? va - vb : a.effectiveAdvPct - b.effectiveAdvPct;
    });

    const fapOrders = orders.filter(o => o.verdict === 'fap');
    return res.status(200).json({
      success: true,
      data: {
        type: 'full_report',
        stats: {
          total: orders.length,
          fulfillable: orders.filter(o => o.verdict === 'fulfillable').length,
          fap: fapOrders.length,
          eta: orders.filter(o => o.verdict === 'eta').length,
          blocked: orders.filter(o => o.verdict === 'blocked').length,
          cashAtRisk: orders.filter(o => o.effectiveAdvPct < 30 && o.bookingAgeDays > 7).reduce((s,o) => s+o.balance, 0),
          fapValue: fapOrders.reduce((s,o) => s+o.balance, 0),
          etaSheetLoaded: Object.keys(etaMap).length
        },
        orders,
        accountsAlerts: orders.filter(o => o.accountsAlert).map(o => ({
          ref: o.ref, customer: o.customer, salesperson: o.salesperson,
          bookingAgeDays: o.bookingAgeDays, advancePct: o.advancePct,
          issue: o.accountsAlert,
          action: o.paymentUnrecorded ? 'record' : o.subStatus?.includes('Cancelled') ? 'review' : o.bookingAgeDays > 30 ? 'dissolve' : 'collect'
        }))
      }
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
