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

  // Build a condensed parts list for Claude (name, partNumber, price, category)
  const partsList = parts
    .filter(p => p.name)
    .map(p => `ID:${p.id} | ${p.name}${p.partNumber ? ' | Part#:'+p.partNumber : ''}${p.price ? ' | $'+parseFloat(p.price).toFixed(2) : ''}${p.category ? ' | '+p.category : ''}${p.boxName ? ' | Loc:'+p.boxName : ''}`)
    .join('\n');

  const prompt = `You are matching an item from a Housecall Pro job ticket to a part in an HVAC company's inventory.

UNMATCHED HCP ITEM:
Name: "${unmatchedItem.itemName}"
Part#: "${unmatchedItem.partNumber || 'none'}"
Qty used: ${unmatchedItem.quantity}
Job #: ${unmatchedItem.jobNumber}

INVENTORY PARTS:
${partsList}

Find the best matching inventory part. Consider:
- Name similarity (even if worded differently, e.g. "1/2 copper elbow" ≈ "CxC 90 Elbow 1/2")
- Part number match if available
- Price similarity
- Category match (HVAC parts)

Respond with ONLY valid JSON in this exact format:
{
  "matchId": "the part ID from inventory or null if no good match",
  "matchName": "the matched part name or null",
  "confidence": 0-100,
  "reason": "brief explanation of why this matches"
}

If no inventory part is a reasonable match, return matchId: null with confidence: 0.`;

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

    // Extract JSON from response
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
