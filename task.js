// task.js — Harley Content Studio Background Task
// Runs in Layla's Task Manager (QuickJS runtime, no imports needed)
// layla.* is injected as a global

const TABLE = "harley_batch_queue";

// Initialize the batch queue table
await layla.db.executeSql(`
  CREATE TABLE IF NOT EXISTS ${TABLE} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    negative TEXT,
    model TEXT DEFAULT 'sd15',
    width INTEGER DEFAULT 512,
    height INTEGER DEFAULT 512,
    steps INTEGER DEFAULT 20,
    cfg_scale INTEGER DEFAULT 7,
    status TEXT DEFAULT 'pending',
    result_base64 TEXT,
    created_at INTEGER NOT NULL,
    completed_at INTEGER
  )
`);

// Get pending jobs
const result = await layla.db.executeSql(
  `SELECT id, prompt, negative, model, width, height, steps, cfg_scale
   FROM ${TABLE}
   WHERE status = 'pending'
   ORDER BY id ASC
   LIMIT 1`
);

if (result.rows.length === 0) {
  console.log("No pending batch jobs.");
} else {
  const job = result.rows[0];
  const r = job;
  console.log(`Processing job ${r.id}: ${r.prompt}`);

  // Mark as in-progress
  await layla.db.executeSql(
    `UPDATE ${TABLE} SET status = 'processing' WHERE id = ?`,
    [r.id]
  );

  try {
    const imgResult = await layla.images.generate({
      prompt: String(r.prompt),
      negative_prompt: r.negative ? String(r.negative) : undefined,
      width: Number(r.width),
      height: Number(r.height),
      steps: Number(r.steps),
      cfg_scale: Number(r.cfg_scale),
      model: String(r.model),
    });

    // Save result
    await layla.db.executeSql(
      `UPDATE ${TABLE} SET status = 'done', result_base64 = ?, completed_at = ? WHERE id = ?`,
      [imgResult.image, Date.now(), r.id]
    );

    console.log(`Job ${r.id} completed successfully.`);
  } catch (err) {
    await layla.db.executeSql(
      `UPDATE ${TABLE} SET status = 'failed' WHERE id = ?`,
      [r.id]
    );
    console.error(`Job ${r.id} failed:`, err);
  }
}

// Report queue status
const stats = await layla.db.executeSql(
  `SELECT status, COUNT(*) as count FROM ${TABLE} GROUP BY status`
);
const counts = {};
for (const row of stats.rows) {
  counts[row.status] = row.count;
}
console.log(`Queue status: ${JSON.stringify(counts)}`);
