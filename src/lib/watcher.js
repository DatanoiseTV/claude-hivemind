'use strict';

// A debounced, filtered recursive filesystem watcher for one project directory.
//
// Design goals (the whole point of this feature): be aware of changes WITHOUT
// ever triggering an LLM. This module only collects and coalesces change events
// and hands a single batched list to its owner (the hub), which records them as
// passive state. Agents see them on a turn they were already taking — no extra
// prompts, no token waste.
//
//   - Debounce: a quiet window collapses a burst (save-all, build, git checkout)
//     into one batch, so nothing is spammed.
//   - Filter: well-known noise (node_modules, .git, build output, logs, temp
//     files) is dropped before it ever reaches the owner.
//   - Fail soft: if recursive watching isn't supported or errors (EMFILE on a
//     huge tree, etc.), it disables itself silently rather than breaking the hub.

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', 'target', 'dist', 'build', 'out', '.next', '.nuxt',
  '.cache', '__pycache__', '.venv', 'venv', 'coverage', '.idea', '.gradle',
  'vendor', '.terraform', '.pytest_cache', '.mypy_cache', '.svelte-kit', 'obj',
  '.turbo', '.parcel-cache', 'Pods', 'DerivedData', '.vite', '.angular',
  '.astro', '.docusaurus', '.expo', '.dart_tool', '.tox', '.eggs',
  '.ruff_cache', '.ccls-cache', '.clangd', '.ipynb_checkpoints', 'tmp', '.tmp',
  '.serverless', '.vercel', '.output', 'bower_components', 'jspm_packages',
]);

// Noise file suffixes: build/object outputs, caches, db journals, coverage,
// runtime files, source maps, editor temps — things that churn constantly and
// carry no signal about what a human or agent is doing.
const IGNORE_SUFFIX =
  /\.(log|tmp|temp|swp|swo|swx|part|crdownload|pyc|pyo|class|o|obj|gcda|gcno|pid|sock|map|orig|rej|bak|db-wal|db-shm|db-journal|sqlite-wal|sqlite-shm|sqlite-journal)$/i;

// True if a path (relative to the watched root) is noise we never surface.
function isIgnored(rel, extra) {
  const parts = rel.split(path.sep).filter(Boolean);
  for (const p of parts) {
    if (IGNORE_DIRS.has(p)) return true;
    // cmake-build-*, .gradle caches, etc.
    if (/^cmake-build-/.test(p)) return true;
  }
  const base = parts[parts.length - 1] || '';
  if (base === '.DS_Store' || base === '.git') return true;
  if (IGNORE_SUFFIX.test(base)) return true;
  if (base.endsWith('~')) return true;
  if (base.startsWith('.#')) return true; // emacs lockfiles
  if (extra && extra.length && extra.some((frag) => rel.includes(frag))) return true;
  return false;
}

// Start watching `dir`. Calls onBatch(absolutePaths[]) after a quiet window.
// Returns { close() }. Never throws; on failure returns a no-op closer.
function createProjectWatcher(dir, opts = {}) {
  const { debounceMs = 1500, maxBatch = 400, ignore = [], onBatch, onError } = opts;
  let watcher = null;
  let timer = null;
  const pending = new Set();
  let dropped = 0;

  const flush = () => {
    timer = null;
    if (!pending.size && !dropped) return;
    const paths = [...pending];
    const overflow = dropped;
    pending.clear();
    dropped = 0;
    try {
      if (onBatch) onBatch(paths, overflow);
    } catch (_) {
      /* owner errors must not kill the watcher */
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
    // Don't let the watcher alone keep the hub alive (so idle-shutdown works).
    if (timer.unref) timer.unref();
  };

  try {
    watcher = fs.watch(dir, { recursive: true, persistent: false }, (_event, filename) => {
      if (!filename) return;
      const rel = filename.toString();
      if (isIgnored(rel, ignore)) return;
      if (pending.size < maxBatch) {
        pending.add(path.resolve(dir, rel));
      } else {
        dropped++;
      }
      schedule();
    });
    watcher.on('error', (err) => {
      if (onError) onError(err);
      try {
        watcher.close();
      } catch (_) {
        /* ignore */
      }
      watcher = null;
    });
  } catch (err) {
    if (onError) onError(err);
    return { close() {} };
  }

  return {
    close() {
      if (timer) clearTimeout(timer);
      try {
        if (watcher) watcher.close();
      } catch (_) {
        /* ignore */
      }
      watcher = null;
    },
  };
}

module.exports = { createProjectWatcher, isIgnored };
