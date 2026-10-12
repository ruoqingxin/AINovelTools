import assert from "node:assert/strict";

export const manuscriptGate = "acceptance_manuscript_interruption";
export const jobGate = "acceptance_job_interruption";

function delay(iterations) {
  assert(Number.isSafeInteger(iterations) && iterations >= 1 && iterations <= 100_000_000,
    "delay iterations must be an integer between 1 and 100000000");
  return `SELECT max(n) FROM (
    WITH RECURSIVE acceptance_delay(n) AS (
      VALUES(0) UNION ALL SELECT n+1 FROM acceptance_delay WHERE n<${iterations}
    ) SELECT n FROM acceptance_delay
  );`;
}

// Only the harness's freshly created synthetic database receives these gates.
// AFTER DELETE holds the formal transaction after revision insertion and draft
// clearing and recovery deletion, but before the transaction can be committed.
export function installManuscriptGate(db, chapterId, iterations = 100_000_000) {
  assert.match(chapterId, /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i, "chapter ID must be a UUID");
  db.exec(`CREATE TRIGGER ${manuscriptGate} AFTER DELETE ON recovery_logs
    WHEN OLD.chapter_id='${chapterId}' BEGIN ${delay(iterations)} END;`);
}

export function installJobGate(db, iterations = 100_000_000) {
  db.exec(`CREATE TRIGGER ${jobGate} AFTER UPDATE ON jobs
    WHEN OLD.status='RUNNING' AND NEW.status='SUCCEEDED'
      AND NEW.job_type='REBUILD_SEARCH_INDEX'
    BEGIN ${delay(iterations)} END;`);
}

export function writerLocked(db) {
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    if (error.errcode === 5) return true; // SQLITE_BUSY only, not an arbitrary database error.
    throw error;
  }
  db.exec("ROLLBACK");
  return false;
}

export function manuscriptSnapshot(db, chapterId) {
  // One read transaction avoids comparing records from different commit points.
  db.exec("BEGIN");
  try {
    return {
      revisions: db.prepare("SELECT * FROM manuscript_revisions WHERE chapter_id=? ORDER BY rowid").all(chapterId),
      draft: db.prepare("SELECT * FROM manuscript_drafts WHERE chapter_id=?").get(chapterId),
      recovery: db.prepare("SELECT * FROM recovery_logs WHERE chapter_id=? ORDER BY rowid").all(chapterId),
      index: db.prepare("SELECT * FROM search_index ORDER BY object_type,object_id").all(),
    };
  } finally {
    db.exec("ROLLBACK");
  }
}
