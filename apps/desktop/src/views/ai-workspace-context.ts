import { createContext, useContext } from "react";

// Keep workspace identity independent of hot-reloaded presentation components.
export const AiWorkspaceContext = createContext(false);
export const useInAiWorkspace = () => useContext(AiWorkspaceContext);
