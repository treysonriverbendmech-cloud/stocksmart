// AI-powered matching of unmatched HCP line items to Partlocker inventory
// Uses Claude API to find the best inventory match based on name, price, and date

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { unmatchedItem, parts } = body;
  if (!unmatchedItem || !parts?.length) {
    return { statusCode: 400, body: JSON.stringify({ error: 'Missing unmatchedItem or parts' }) };
  }

  const jobDate = unmatchedItem.completedAt ? new Date(unmatchedItem.completedAt).toISOString().slice(0,10) : null;
  const hcpPrice = unmatchedItem.unitPrice ? parseFloat(unmatchedItem.unitPrice) : null;

  const partsList = parts
    .filter(p => p.name)
    .map(p => {
      const partDate = p.createdAt ? new Date(p.createdAt).toISOString().slice(0,10) : null;
      const sameDay = jobDate && partDate && partDate === jobDate ? ' ⭐SAME-DAY' : '';
      const daysDiff = jobDate && partDate ? Math.abs((new Date(jobDate) - new Date(partDate)) / 86400000) : null;
      const nearDate = daysDiff !== null && daysDiff <= 3 && daysDiff > 0 ? ` [±${Math.round(daysDiff)}d]` : '';
      const priceMatch = hcpPrice && p.price && Math.abs(parseFloat(p.price) - hcpPrice) < 0.01 ? ' 💰PRICE-MATCH' : '';
      return `ID:${p.id} | ${p.name}${p.partNumber ? ' | #'+p.partNumber : ''}${p.price ? ' | $'+parseFloat(p.price).toFixed(2) : ''}${p.category ? ' | '+p.category : ''}${p.boxName ? ' | '+p.boxName : ''}${priceMatch}${sameDay||nearDate}`;
    })
    .join('\n');

  const prompt = `You are an expert HVAC parts matcher. Match this Housecall Pro invoice item to the best inventory part.

HCP ITEM:
Name: "${unmatchedItem.itemName}"
Part#: ${unmatchedItem.partNumber && unmatchedItem.partNumber !== '—' ? unmatchedItem.partNumber : 'none'}
Price: ${hcpPrice ? '$' + hcpPrice.toFixed(2) : 'unknown'}
Qty: ${unmatchedItem.quantity}
Job#: ${unmatchedItem.jobNumber} | Tech: ${unmatchedItem.tech || 'unknown'}

INVENTORY (parts marked 💰PRICE-MATCH have the exact same price, ⭐SAME-DAY were added on the same date as the job):
${partsList}

MATCHING RULES — apply in this order:
1. 💰PRICE-MATCH + ⭐SAME-DAY → 95% confidence minimum, almost certainly the match
2. 💰PRICE-MATCH + close name/description → 85%+ confidence
3. 💰PRICE-MATCH alone (if only 1 part at that price) → 80% confidence
4. Name similarity → HVAC techs use many abbreviations and brand names:
   - "Cap 45/5" = "Dual Run Capacitor 45+5 MFD"
   - "Cond Fan Motor" = "Condenser Fan Motor"
   - "TXV" = "Thermostatic Expansion Valve"
   - Partial matches count — match on key specs (size, voltage, amperage, refrigerant type)
5. Part number match → 90%+
6. Same category/type with similar price → 60%+

Be AGGRESSIVE — if price matches OR date is within 3 days AND description is plausibly the same part, suggest it at 70%+.
Only return null if there is genuinely no reasonable match.

Respond with ONLY valid JSON:
{
  "matchId": "the exact part ID from inventory, or null",
  "matchName": "the matched part name, or null",
  "confidence": 0-100,
  "reason": "one sentence: what matched and why (mention price/date if relevant)"
}`;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!resp.ok) {
      const err = await resp.text();
      return { statusCode: 500, body: JSON.stringify({ error: 'Claude API error: ' + err.substring(0, 200) }) };
    }

    const data = await resp.json();
    const text = data.content?.[0]?.text || '{}';

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { statusCode: 200, body: JSON.stringify({ matchId: null, confidence: 0, reason: 'No match found' }) };
    }

    const result = JSON.parse(jsonMatch[0]);
    return { statusCode: 200, body: JSON.stringify(result) };

  } catch (err) {
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
};
