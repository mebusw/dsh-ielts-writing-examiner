// Question bank — read bundled assets/雅思真题.json.
//
// Schema (rewritten by migration step 3):
//   {
//     "writing-task-1-Academy": [ { region, date, task, topic, type, images: [relPath], tags: [...] } ],
//     "writing-task-2-Academy": [ ... ]
//   }
//
// images[] is relative to /ielts-examiner/asset/ (e.g. "images-for-task1/foo.png").
// We hand the client bare relative paths and let it compose the URL.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

let cache = null;

export function loadBank(pluginRoot) {
  if (cache) return cache;
  const p = join(pluginRoot, 'assets', '雅思真题.json');
  if (!existsSync(p)) {
    cache = { items: [], byTask: { '1': [], '2': [] } };
    return cache;
  }
  const raw = JSON.parse(readFileSync(p, 'utf8'));
  const items = [];
  for (const [groupKey, list] of Object.entries(raw)) {
    const taskNum = groupKey.includes('task-1') ? '1' : groupKey.includes('task-2') ? '2' : '?';
    for (const q of list) {
      items.push({
        id: `${groupKey}/${q.topic || q.date || items.length}`,
        task: taskNum,
        title: q.topic || '(untitled)',
        type: q.type || '',
        date: q.date || '',
        region: q.region || '',
        tags: q.tags || [],
        body: q.task || '',
        images: Array.isArray(q.images) ? q.images : [],
      });
    }
  }
  cache = {
    items,
    byTask: {
      '1': items.filter((i) => i.task === '1'),
      '2': items.filter((i) => i.task === '2'),
    },
  };
  return cache;
}

/** Resolve one item by id (groupKey/topic). Returns null if not found. */
export function findById(pluginRoot, id) {
  const bank = loadBank(pluginRoot);
  return bank.items.find((i) => i.id === id) || null;
}
