// One-time migration: push data.json into Firestore at trackTimer/state
// Run with:
//   node tools/migrate.js
// Requires GOOGLE_APPLICATION_CREDENTIALS pointed at a key for the hare-family-apps project.

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const dataPath = path.join(__dirname, '..', 'data.json');
const raw = JSON.parse(fs.readFileSync(dataPath, 'utf8'));

const projectId = 'hare-family-apps';
const firestore = new Firestore({ projectId });

(async () => {
  const ref = firestore.doc('trackTimer/state');
  const snap = await ref.get();
  const current = snap.exists ? snap.data() : { runners: [], events: [], races: [] };

  const existingIds = new Set((current.races || []).map(r => r.id));
  const newRaces = (raw.races || []).filter(r => !existingIds.has(r.id));

  const merged = {
    runners: current.runners && current.runners.length ? current.runners : raw.runners,
    events: current.events && current.events.length ? current.events : raw.events,
    races: [...newRaces, ...(current.races || [])].sort((a, b) => new Date(b.date) - new Date(a.date)),
    updatedAt: Firestore.FieldValue.serverTimestamp()
  };

  await ref.set(merged);
  console.log(`Migration complete: ${newRaces.length} new races merged, ${merged.races.length} total.`);
})().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
