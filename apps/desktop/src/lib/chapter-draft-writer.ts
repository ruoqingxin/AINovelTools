import { commitManuscriptDraft, discardManuscriptDraft, saveManuscriptDraft, type ManuscriptDraft } from "./tauri-client";

export type ChapterDraftContent = { documentJson: string; baseRevisionId?: string };

export function createChapterDraftWriter(initial: ManuscriptDraft) {
  let persisted = initial;
  let queue: Promise<unknown> = Promise.resolve();
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.then(operation);
    queue = next.catch(() => undefined);
    return next;
  }
  async function save(content: ChapterDraftContent) {
    if (persisted.documentJson === content.documentJson && persisted.baseRevisionId === (content.baseRevisionId ?? null)) return persisted;
    persisted = await saveManuscriptDraft({ chapterId: initial.chapterId, ...content, expectedVersion: persisted.version });
    return persisted;
  }
  return {
    current: () => persisted,
    idle: () => queue,
    save: (content: ChapterDraftContent) => enqueue(() => save(content)),
    commit: (content: ChapterDraftContent) => enqueue(async () => {
      await save(content);
      const committed = await commitManuscriptDraft({
        chapterId: initial.chapterId, ...content, expectedVersion: persisted.version,
      });
      persisted = committed.draft;
      return committed;
    }),
    discard: () => enqueue(async () => {
      persisted = await discardManuscriptDraft({ chapterId: initial.chapterId, expectedVersion: persisted.version });
      return persisted;
    }),
  };
}
