// === Orange Book Full NDC Query ===
app.get('/query', async (req, res) => {
  const ndc = req.query.ndc;
  if (!ndc) {
    return res.status(400).json({ error: 'Missing NDC parameter' });
  }

  const normalized = normalizeNdcToProductOnly(ndc);

  try {
    const row = await db.get(
      `SELECT * FROM orangebook_combined WHERE Normalized_PRODUCTNDC = ?`,
      [normalized]
    );

    if (!row) {
      return res.status(404).json({ error: 'No Orange Book match found' });
    }

    res.json(row);
  } catch (err) {
    console.error('❌ Orange Book query error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});
