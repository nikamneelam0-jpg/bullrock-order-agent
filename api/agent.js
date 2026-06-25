export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, zohoToken } = req.body;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
  if (!CLAUDE_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not set in Vercel environment variables' });
  if (!zohoToken) return res.status(400).json({ error: 'Zoho token missing' });

  const ORG = '60013876707';
  const today = new Date(); today.setHours(0,0,0,0);

  try {
    const zH = { 'Authorization': `Zoho-oauthtoken ${zohoToken}` };
    const [soRes, unpRes, parRes] = await Promise.all([
      fetch(`https://books.zoho.in/api/v3/salesorders?filter_by=Status.Open&per_page=200&organization_id=${ORG}`, { headers: zH }),
      fetch(`https://books.zoho.in/api/v3/invoices?status=unpaid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH }),
      fetch(`https://books.zoho.in/api/v3/invoices?status=partially_paid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers: zH })
    ]);

    if (!soRes.ok) return res.status(401).json({ error: `Zoho auth failed (${soRes.status}) — token expired. Get a new one from api-console.zoho.in → Self Client → Generate Token` });

    const [soData, unpData, parData] = await Promise.all([soRes.json(), unpRes.json(), parRes.json()]);
    const salesorders = soData.salesorders || [];
    const unpaid = unpData.invoices || [];
    const partial = parData.invoices || [];

    const confirmedSOs = salesorders.filter(so =>
      ['cs_preorde','cs_website','cs_verifie','open'].includes(so.current_sub_status)
    );

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
      const d = new Date(s); d.setHours(0,0,0,0);
      return Math.ceil((d - today) / 86400000);
    }

    function classify(ref, cust, sp, esd, confirmed, total, bal, note, sub, id, type) {
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

      let verdict='fulfillable', vl='Ready to dispatch', action='Book shipping now';
      if (sub?.includes('Cancelled')) { verdict='urgent'; vl='Cancelled — review'; action='Decide: refund or dispatch'; }
      else if (d !== null && d < 0) { verdict='urgent'; vl=`${Math.abs(d)}d lapsed`; action='Contact customer immediately'; }
      else if (effAdv < 30 && d !== null && d > 30) { verdict='fap'; vl='FAP candidate'; action='Low advance — reallocate if urgent buyer found'; }
      else if (effAdv < 30 && age > 7 && !note) { verdict='blocked'; vl='No payment'; action='Collect advance or dissolve order'; }

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
        lineItems: [{ sku:'—', name:'Click Open in Zoho for line items', qty:1, status: effAdv<30&&d!==null&&d>30?'fap':d!==null&&d<0?'blocked':'stock', statusLabel: vl, detail:'' }],
        accountsAlert: acct
      };
    }

    const orders = [];
    confirmedSOs.forEach(so => orders.push(classify(
      so.salesorder_number, so.customer_name, so.salesperson_name,
      so.shipment_date, so.cf_confirmed_date_unformatted||so.date,
      parseFloat(so.total)||0, parseFloat(so.balance)||0,
      so.custom_field_hash?.cf_payment_note||'',
      so.current_sub_status, so.salesorder_id, 'so'
    )));

    bfld.forEach(inv => orders.push(classify(
      inv.invoice_number, inv.customer_name, inv.salesperson_name,
      inv.due_date||inv.custom_field_hash?.cf_expected_shipment_date||'',
      inv.date, parseFloat(inv.total)||0, parseFloat(inv.balance)||0,
      '', inv.status, inv.invoice_id, 'inv'
    )));

    orders.sort((a,b) => {
      if (a.verdict==='urgent'&&b.verdict!=='urgent') return -1;
      if (b.verdict==='urgent'&&a.verdict!=='urgent') return 1;
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
        fapValue: fapOrders.reduce((s,o)=>s+o.balance,0)
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
    return res.status(500).json({ error: e.message });
  }
}
