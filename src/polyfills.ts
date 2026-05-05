import { installRandomUUIDFallback } from "./lib/generate-id";

// Browsers on plain HTTP may expose crypto without randomUUID().
installRandomUUIDFallback();
