// dsh-ielts-examiner host entry.
//
// Thin re-export so the DSH host loader (which imports package main) gets
// name/inject/apply. Mirrors pomasa-studio/src/host/apply.js shape.

export { name, inject, apply } from './apply.js';
