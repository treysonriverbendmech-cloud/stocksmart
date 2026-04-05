exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const apiKey = (process.env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }) };
  }

  let imageBase64, mediaType;
  try {
    ({ imageBase64, mediaType } = JSON.parse(event.body));
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: 'Invalid request body' }) };
  }

  const prompt = `Analyze this inventory item photo. Respond with ONLY a valid JSON object — no markdown, no explanation:
{
  "name": "specific item name (brand + model if visible)",
  "category": "one of: Electronics, Furniture, Clothing, Tools, Food, Books, Sports, Toys, Kitchen, Office, Other",
  "price": estimated resale value as a number (no $ sign, e.g. 49.99),
  "notes": "brief 1-2 sentence description of condition, color, key features"
}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 512,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: mediaType || 'image/jpeg',
                  data: imageBase64,
                },
              },
              { type: 'text', text: prompt },
            ],
          },
        ],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      console.error('Anthropic API error:', errText);
      return { statusCode: 502, body: JSON.stringify({ error: 'AI service error', detail: errText }) };
    }

    const data = await response.json();
    const raw = data.content?.[0]?.text || '';

    // Extract JSON from response (handle any stray text)
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return { statusCode: 500, body: JSON.stringify({ error: 'Could not parse AI response', raw }) };
    }

    const result = JSON.parse(match[0]);

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(result),
    };
  } catch (err) {
    console.error('Function error:', err);
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, stack: err.stack }),
    };
  }
};
