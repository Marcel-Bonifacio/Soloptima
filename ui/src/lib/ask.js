// Yes-or-no questions in the app's own dialog (screens/AskDialog.svelte). window.confirm() is not used: the macOS web view of the
// shell has no panel for it and answers Cancel at once without showing anything.

let show = null;

// AskDialog registers how it shows a question: show(text, yes) -> Promise<boolean>
export function setAsker(fn) { show = fn; }

// ask('Delete this datasheet?', 'Delete') -> true when the user chose the `yes` button; false on Cancel, Escape, or when no dialog
// is there to ask (a question nobody sees never deletes anything)
export const ask = (text, yes = 'OK') => (show ? show(text, yes) : Promise.resolve(false));
