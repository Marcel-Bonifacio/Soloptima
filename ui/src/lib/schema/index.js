// The single description of the project inputs (docs/ui.md): the default project, the forms, and the constants they use.
import { FORMS_A } from './forms-a.js';
import { FORMS_B } from './forms-b.js';

export const FORMS = { ...FORMS_A, ...FORMS_B };
export { defaultProject } from './project.js';
export { TORNADO_VARS, LOAD_TEMPLATES, PCT, MOUNT_STYLES, mountStyleOf, PV_FC_METHODS, LOAD_FC_METHODS } from './consts.js';
