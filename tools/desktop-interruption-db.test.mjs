import assert from "node:assert/strict";
import { mkdtempSync, rmdirSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { installJobGate, installManuscriptGate, manuscriptSnapshot, writerLocked } from "./desktop-interruption-db.mjs";

const chapter = "00000000-0000-4000-8000-000000000001";
function setup(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE manuscript_revisions(id TEXT, chapter_id TEXT, document_json TEXT);
    CREATE TABLE manuscript_drafts(chapter_id TEXT, document_json TEXT, version INTEGER);
    CREATE TABLE recovery_logs(id TEXT, chapter_id TEXT, document_json TEXT);
    CREATE TABLE search_index(object_type TEXT, object_id TEXT, content TEXT);
    CREATE TABLE jobs(id TEXT, job_type TEXT, status TEXT, attempt_count INTEGER);
    INSERT INTO manuscript_revisions VALUES ('revision', '${chapter}', 'formal');
    INSERT INTO manuscript_drafts VALUES ('${chapter}', 'draft', 2);
    INSERT INTO recovery_logs VALUES ('recovery', '${chapter}', 'copy');
    INSERT INTO search_index VALUES ('MANUSCRIPT', 'revision', 'formal');
    INSERT INTO jobs VALUES ('job', 'REBUILD_SEARCH_INDEX', 'RUNNING', 1);
  `);
  return db;
}

test("SQL delay gates reject interpolated IDs and unbounded delays without installing a trigger", (t) => {
  const db = setup(t);
  assert.throws(() => installManuscriptGate(db, "'; DROP TABLE jobs; --", 1), /UUID/);
  for (const iterations of [0, -1, 1.5, 100_000_001, "1"]) {
    assert.throws(() => installManuscriptGate(db, chapter, iterations), /iterations/);
    assert.throws(() => installJobGate(db, iterations), /iterations/);
  }
  assert.equal(db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='trigger'").get().n, 0);
});

test("manuscript gate runs inside the caller transaction and rollback preserves the entire snapshot", (t) => {
  const db = setup(t);
  installManuscriptGate(db, chapter, 12);
  const before = manuscriptSnapshot(db, chapter);
  db.exec(`BEGIN IMMEDIATE;
    INSERT INTO manuscript_revisions VALUES ('new', '${chapter}', 'new formal');
    UPDATE manuscript_drafts SET document_json=NULL,version=3;
    DELETE FROM recovery_logs WHERE chapter_id='${chapter}';
    DELETE FROM search_index;
    ROLLBACK;`);
  assert.deepEqual(manuscriptSnapshot(db, chapter), before);
  db.exec(`BEGIN IMMEDIATE; DELETE FROM recovery_logs WHERE chapter_id='${chapter}'; COMMIT;`);
  assert.equal(db.prepare("SELECT count(*) AS n FROM recovery_logs").get().n, 0);
});

test("job completion gate does not create a terminal receipt on rollback", (t) => {
  const db = setup(t);
  installJobGate(db, 12);
  db.exec("BEGIN IMMEDIATE; UPDATE jobs SET status='SUCCEEDED'; ROLLBACK;");
  assert.deepEqual({ ...db.prepare("SELECT status,attempt_count FROM jobs").get() }, { status: "RUNNING", attempt_count: 1 });
  db.exec("UPDATE jobs SET status='SUCCEEDED'");
  assert.equal(db.prepare("SELECT status FROM jobs").get().status, "SUCCEEDED");
});

test("writer probe detects another connection and releases its own lock without swallowing errors", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "ainovel-interruption-test-"));
  const path = join(directory, "test.sqlite");
  const first = new DatabaseSync(path);
  const second = new DatabaseSync(path);
  t.after(() => {
    first.close();
    second.close();
    unlinkSync(path);
    rmdirSync(directory);
  });
  first.exec("CREATE TABLE sample(value TEXT); INSERT INTO sample VALUES('unchanged');");
  second.exec("PRAGMA busy_timeout=0");
  assert.equal(writerLocked(second), false);
  first.exec("BEGIN IMMEDIATE");
  assert.equal(writerLocked(second), true);
  first.exec("ROLLBACK");
  assert.equal(writerLocked(second), false);
  first.exec("BEGIN IMMEDIATE; ROLLBACK;");
  assert.equal(second.prepare("SELECT value FROM sample").get().value, "unchanged");
  const closed = new DatabaseSync(":memory:");
  closed.close();
  assert.throws(() => writerLocked(closed));
});
