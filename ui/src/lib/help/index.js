// The help texts of the ⓘ buttons, by input path (or a topic name): { key: [text, example] }.
import { HELP_A } from './a.js';
import { HELP_A2 } from './a2.js';
import { HELP_B } from './b.js';
import { HELP_C } from './c.js';

export const HELP = { ...HELP_A, ...HELP_A2, ...HELP_B, ...HELP_C };
export const hasHelp = (key) => !!HELP[key];
