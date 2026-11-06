// Browser storage that never throws (blocked storage reads as empty)
export function storeGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
export function storeSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }
export function storeRemove(k) { try { localStorage.removeItem(k); } catch (e) { /* blocked */ } }
export const STORE_KEY = 'soloptima.project.v1';   // where the first versions kept the projects (browser storage)
