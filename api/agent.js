export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { message, zohoToken } = req.body;
  const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;

  if (!CLAUDE_KEY) return res.status(500).json({ error: 'API key not configured' });

  try {
    // 1. Fetch Zoho data server-side (no CORS issues)
    const ORG = '60013876707';
    const headers = { 'Authorization': `Zoho-oauthtoken ${zohoToken}` };

    const [soResp, unpResp, parResp] = await Promise.all([
      fetch(`https://books.zoho.in/api/v3/salesorders?filter_by=Status.Open&per_page=200&organization_id=${ORG}`, { headers }),
      fetch(`https://books.zoho.in/api/v3/invoices?status=unpaid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers }),
      fetch(`https://books.zoho.in/api/v3/invoices?status=partially_paid&per_page=200&sort_column=due_date&organization_id=${ORG}`, { headers })
    ]);

    const soData = await soResp.json();
    const unpData = await unpResp.json();
    const parData = await parResp.json();

    const zohoData = {
      salesorders: soData.salesorders || [],
      unpaid: unpData.invoices || [],
      partial: parData.invoices || []
    };

    // 2. Call Claude with the data
    const SYS = `You are the BullrocK Order Intelligence Agent for BullrocK Fitness, Nashik (Org: 60013876707).

Analyse the Zoho Books data provided and return ONLY valid JSON in this exact format:
{"type":"full_report","stats":{"total":0,"fulfillable":0,"fap":0,"eta":0,"blocked":0,"cashAtRisk":0,"fapValue":0},"orders":[{"ref":"","customer":"","salesperson":"","esd":"","daysToEsd":0,"confirmedDate":"","bookingAgeDays":0,"total":0,"balance":0,"advancePct":0,"effectiveAdvPct":0,"paymentNote":"","paymentUnrecorded":false,"subStatus":"","verdict":"fulfillable","verdictLabel":"","action":"","zohoUrl":"","lineItems":[{"sku":"","name":"","qty":0,"status":"stock","statusLabel":"","detail":""}],"accountsAlert":""}],"accountsAlerts":[{"ref":"","customer":"","salesperson":"","bookingAgeDays":0,"advancePct":0,"issue":"","action":"dissolve"}]}

RULES:
- Include confirmed open SOs (sub_status: cs_preorde/cs_website/cs_verifie) and BFLD invoices where cf_shipped=No
- Per line item verdict: SOH>=qty=IN STOCK, SOH=0+ETA found=ON ETA [date], SOH=0+ETA+another order has same SKU with advance<30% AND ESD after ETA AND booked later=FAP POSSIBLE (name invoice/customer/advance%/ESD), SOho=0+no ETA=BLOCKED
- Priority: higher advance% > earlier cf_confirmed_date > closer ESD
- Parse cf_payment_note for unrecorded payments — if payment in notes but Zoho shows 0%, flag paymentUnrecorded=true
- Booked>7d + effective advance<30% + no payment note = dissolve/collect in accountsAlerts
- verdict values: fulfillable / fap / eta / blocked / urgent
- Return ONLY valid JSON, no markdown, no explanation`;

    const claudeResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': CLAUDE_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 4000,
        system: SYS,
        messages: [{ role: 'user', content: message + '\n\nZoho data:\n' + JSON.stringify(zohoData) }]
      })
    });

    const claudeData = await claudeResp.json();
    const txt = claudeData.content?.filter(b => b.type === 'text').map(b => b.text).join('') || '';

    let parsed = null;
    try { const m = txt.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); } catch (e) {}

    res.status(200).json({ success: true, data: parsed, raw: txt });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
