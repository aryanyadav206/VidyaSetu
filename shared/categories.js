export const CONTENT_CATEGORIES = [
  { value: 'notes', label: 'Notes', description: 'Study notes, reference material, and reading.' },
  { value: 'pyqs', label: 'PYQs', description: 'Previous year question papers for practice.' },
  { value: 'assignment', label: 'Assignment', description: 'Assignment questions and supporting files.' },
  { value: 'lab-experiments', label: 'Lab Experiments', description: 'Lab manuals, practicals, and experiment guides.' },
  { value: 'important-announcements', label: 'Important Announcements', description: 'Important course updates and notices.' }
];
export const CATEGORY_VALUES = CONTENT_CATEGORIES.map(category => category.value);
