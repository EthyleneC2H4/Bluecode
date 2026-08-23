# BlueCode Plugin Smoke Test Checklist

This checklist validates the @bluecode/opencode-plugin-bluecode integration in a real opencode session. Each step includes the verification command.

## Prerequisites

- opencode installed and on PATH
- Model API key configured (for M7 execution)
- BlueCode monorepo built: `bun run build` from repo root

## Setup

```bash
# From repo root
cd /Users/ethylene/Learning/Work/Project/BlueCode/bluecode
bun run build

# Note the plugin path
PLUGIN_PATH="file:///Users/ethylene/Learning/Work/Project/BlueCode/bluecode/packages/plugin"
```

---

## Step 1: Configure Plugin

**Action:** Add plugin to opencode.json

```json
{
  "plugin": [
    ["file:///Users/ethylene/Learning/Work/Project/BlueCode/bluecode/packages/plugin", {
      "enabled": true,
      "rtk": { "budgetTokens": 512, "timeoutMs": 40, "minBytes": 512 },
      "headroom": { "triggerRatio": 0.7, "retainRecentTurns": 4, "fallback": "upstream" }
    }]
  ]
}
```

**Verification:**
```bash
cat ~/.config/opencode/opencode.json | jq '.plugin'
# Should show the plugin array with bluecode entry
```

---

## Step 2: Start opencode Session

**Action:** Launch opencode in a test directory

```bash
mkdir -p /tmp/bluecode-smoke && cd /tmp/bluecode-smoke
opencode
```

**Verification:**
- opencode TUI starts without errors
- Plugin loads (check logs for `[bluecode-plugin]` prefix)

---

## Step 3: Test rtk Compression (tool.execute.after)

**Action:** Run a command producing large output (e.g., `ls -la` on large directory, or run tests)

```bash
# In opencode: ask "list all files in /usr/include recursively" or run a test suite
```

**Verification:**
```bash
# Check tool output in session - should be compressed
# Look for metadata.bluecode.rawHash in the tool call metadata
# Output should contain: [bluecode rtk] compressed: rawHash=sha256:...
# And reference: headroom_retrieve(hash="sha256:...")
```

---

## Step 4: Verify headroom_retrieve by Hash

**Action:** In opencode, invoke the headroom_retrieve tool with the hash from Step 3

```bash
# In opencode chat: "use headroom_retrieve with hash=sha256:..."
```

**Verification:**
- Tool returns full original content
- Content matches what was compressed (byte-for-byte)

---

## Step 5: Test headroom_retrieve by Query

**Action:** Search for content from history

```bash
# In opencode chat: "use headroom_retrieve with query='test function'"
```

**Verification:**
- Returns top-N hits with scores, hashes, turn indices, roles, snippets
- Results are relevant to query

---

## Step 6: Trigger Long-Session Compaction

**Action:** Have a long conversation until token waterlevel is reached (triggerRatio × contextWindow)

```bash
# In opencode: continue conversation with large context
# Or manually trigger by sending many large messages
```

**Verification:**
- Session status shows "idle" event triggers compaction
- Look for `[bluecode 历史压缩]` block in message history
- Block contains: summary, refs (hash list), retrieve hint with historyHash

---

## Step 7: Verify headroomd Store Persistence

**Action:** Check headroomd data directory after compaction

```bash
ls -la ~/.tmp/bluecode-headroom/  # or custom dataDir
# Should have:
# - index.db (SQLite index)
# - objects/00/... (CAS objects, sharded by hash prefix)
# - headroomd.sock (daemon socket)
# - headroomd.pid (daemon PID file)
```

**Verification:**
```bash
# Verify CAS objects exist
find ~/.tmp/bluecode-headroom/objects -name "*.bin" | head -5
# Should show content-addressable objects

# Verify index has entries
sqlite3 ~/.tmp/bluecode-headroom/index.db "SELECT count(*) FROM cas_meta;"
# Should return > 0
```

---

## Step 8: Test Daemon Failure Resilience

**Action:** Kill headroomd daemon and continue session

```bash
# Find and kill headroomd
pkill -f "headroomd"

# In opencode: continue conversation, run tools
```

**Verification:**
- Session continues without crashing
- rtk compression shows `metadata.bluecode.degraded: "spawn_failed"` or similar
- headroom_retrieve returns friendly error message
- New headroomd auto-spawns on next idle event (if spawn recipe configured)

---

## Step 9: Verify Compaction Fallback (upstream)

**Action:** With `fallback: "upstream"`, trigger compaction and check compacting hook injection

```bash
# In opencode: check compacting prompt includes headroom context
```

**Verification:**
- Compaction prompt includes injected context about history retrieval
- Text mentions `headroom_retrieve` tool usage

---

## Step 10: Verify Compaction Fallback (passthrough)

**Action:** Configure `fallback: "passthrough"` and trigger compaction

```bash
# Update opencode.json: "fallback": "passthrough"
# Restart opencode, trigger compaction
```

**Verification:**
- No injected context in compacting prompt
- Upstream compaction proceeds normally

---

## Expected Observations Summary

| Step | Expected Observation |
|------|---------------------|
| 1 | Plugin loads in opencode.json |
| 2 | opencode starts, plugin initializes |
| 3 | Tool output compressed, `metadata.bluecode.rawHash` present |
| 4 | `headroom_retrieve(hash="...")` returns original content |
| 5 | `headroom_retrieve(query="...")` returns ranked hits |
| 6 | `[bluecode 历史压缩]` block appears with summary + refs + historyHash |
| 7 | CAS objects + index.db populated in dataDir |
| 8 | Session survives daemon kill, degraded markers appear |
| 9 | Compaction prompt includes retrieval hint (upstream mode) |
| 10 | No retrieval hint in compaction prompt (passthrough mode) |

---

## Verification Commands Quick Reference

```bash
# Check plugin loaded
grep -r "bluecode-plugin" ~/.local/share/opencode/logs/

# Check rtk metadata in session
# (Inspect tool call metadata in opencode UI)

# Check headroomd store
ls -la $BLUECODE_DATA_DIR/  # or ~/.tmp/bluecode-headroom/

# Check CAS objects
find $BLUECODE_DATA_DIR/objects -type f | wc -l

# Check SQLite index
sqlite3 $BLUECODE_DATA_DIR/index.db ".tables"
sqlite3 $BLUECODE_DATA_DIR/index.db "SELECT * FROM cas_meta LIMIT 5;"

# Check daemon process
ps aux | grep headroomd
```