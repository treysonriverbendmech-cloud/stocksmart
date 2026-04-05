exports.handler = async () => {
  const apiKey = (process.env.FIREBASE_API_KEY || '').trim();
  console.log('FIREBASE_API_KEY first 10 chars:', apiKey.slice(0, 10) || '(empty)');
  console.log('FIREBASE_API_KEY length:', apiKey.length);
  if (!apiKey) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'FIREBASE_API_KEY not configured' }),
    };
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
