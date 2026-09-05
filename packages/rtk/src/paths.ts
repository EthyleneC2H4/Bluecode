/** Shared by client and engine without importing SQLite into the host. */
import { defaultDataDir, storageLayout } from "@bluecode/shared"
export const DEFAULT_DATA_DIR = storageLayout(defaultDataDir()).rtk
