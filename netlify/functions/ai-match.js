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
  const jobDate = unmatchedItem.completedAt ? new Date(unmatchedItem.completedAt).toISOString().slice(0,10) : null;

  const partsList = parts
    .filter(p => p.name)
    .map(p => {
      const partDate = p.createdAt ? new Date(p.createdAt).toISOString().slice(0,10) : null;
      const sameDay = jobDate && partDate && partDate === jobDate ? ' | ⭐ ADDED SAME DAY AS JOB' : '';
      const daysDiff = jobDate && partDate ? Math.abs((new Date(jobDate) - new Date(partDate)) / 86400000) : null;
      const nearDate = daysDiff !== null && daysDiff <= 3 && daysDiff > 0 ? ` | added ${Math.round(daysDiff)}d ${new Date(partDate) < new Date(jobDate) ? 'before' : 'after'} job` : '';
      return `ID:${p.id} | ${p.name}${p.partNumber ? ' | Part#:'+p.partNumber : ''}${p.price ? ' | $'+parseFloat(p.price).toFixed(2) : ''}${p.category ? ' | '+p.category : ''}${p.boxName ? ' | Loc:'+p.boxName : ''}${sameDay||nearDate}`;
    })
    .join('\n');

  const prompt = `You are matching an item from a Housecall Pro job ticket to a part in an HVAC company's inventory.

UNMATCHED HCP ITEM:
Name: "${unmatchedItem.itemName}"
Part#: "${unmatchedItem.partNumber || 'none'}"
Price: ${unmatchedItem.unitPrice ? '$' + parseFloat(unmatchedItem.unitPrice).toFixed(2) : 'unknown'}
Qty used: ${unmatchedItem.quantity}
Job #: ${unmatchedItem.jobNumber}
Tech: ${unmatchedItem.tech || 'unknown'}

INVENTORY PARTS:
${partsList}

Find the best matching inventory part. Use this priority order:
1. EXACT price match combined with same-day or within 3 days — very strong signal (part was likely bought for this job)
2. EXACT price match alone — strong signal even if names differ
3. Name similarity — even if worded differently (e.g. "1/2 copper elbow" ≈ "CxC 90 Elbow 1/2", abbreviations like "JR" could match a longer name)
4. Part number match
5. Category match (HVAC parts)

Parts marked ⭐ ADDED SAME DAY AS JOB are very likely the match — a tech scanned a receipt the same day they used the part on a job.
Be willing to suggest a match at 70%+ confidence if price + date align, even if names differ completely.

Respond with ONLY valid JSON in this exact format:
{
  "matchId": "the part ID from inventory or null if no good match",
  "matchName": "the matched part name or null",
  "confidence": 0-100,
  "reason": "brief explanation including price match info if relevant"
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
