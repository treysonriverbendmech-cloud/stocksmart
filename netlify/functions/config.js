exports.handler = async () => {
  const apiKey = process.env.FIREBASE_API_KEY;
  if (!apiKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'FIREBASE_API_KEY not configured' }) };
  }
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      apiKey,
      authDomain:    'stocksmart-6747c.firebaseapp.com',
      projectId:     'stocksmart-6747c',
      storageBucket: 'stocksmart-6747c.appspot.com',
    }),
  };
};
