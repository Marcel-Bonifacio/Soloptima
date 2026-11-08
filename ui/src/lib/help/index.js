// The help texts of the ⓘ buttons, by input path (or a topic name): { key: [text, example] }. The texts are data in help.json.
import HELP_TEXTS from './help.json' with { type: 'json' };

/** @type {Record<string, string[]>} */
export const HELP = HELP_TEXTS;
export const hasHelp = (key) => !!HELP[key];
