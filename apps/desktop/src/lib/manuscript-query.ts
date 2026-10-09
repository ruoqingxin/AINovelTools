import { currentManuscript } from "./tauri-client";

export function manuscriptQuery(chapterId: string | undefined) {
  return {
    queryKey: ["manuscript", chapterId] as const,
    queryFn: () => currentManuscript(chapterId!),
    enabled: Boolean(chapterId),
  };
}
