/**
 * Imported first by scan.mjs. File reads share a small pool of worker threads (4 by default):
 * a few folders that never answer would stall every other probe. A bigger pool keeps the rest
 * of the scan moving. Has to be set before the first asynchronous file call.
 */
process.env.UV_THREADPOOL_SIZE ??= '32'
