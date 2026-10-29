export class ApiError extends Error {
  constructor(message, status) { super(message); this.status = status; }
}
export async function api(path, { method = 'GET', body, rawBody, headers = {} } = {}) {
  let response;
  try {
    response = await fetch(`/api${path}`, { method, credentials: 'same-origin', headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: rawBody ?? (body === undefined ? undefined : JSON.stringify(body)) });
  } catch { throw new ApiError('Could not reach VidyaSetu. Check your connection and try again.', 0); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.error || 'The service is unavailable. Please try again.', response.status);
  return data;
}
export const CourseService = {
  list: () => api('/courses'),
  leave: id => api(`/courses/${encodeURIComponent(id)}/membership`, { method: 'DELETE', body: {} }),
  get: id => api(`/courses/${encodeURIComponent(id)}`),
  create: data => api('/courses', { method: 'POST', body: data }),
  enroll: data => api('/courses/enroll', { method: 'POST', body: data }),
  addLesson: (id, data) => api(`/courses/${encodeURIComponent(id)}/lessons`, { method: 'POST', body: data }),
  removeMaterial: (courseId, itemId) => api(`/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(itemId)}`, { method: 'DELETE', body: {} }),
  removeLesson: (courseId, itemId) => api(`/courses/${encodeURIComponent(courseId)}/lessons/${encodeURIComponent(itemId)}`, { method: 'DELETE', body: {} }),
  uploadMaterial: (id, title, file, category = 'notes') => api(`/courses/${encodeURIComponent(id)}/materials`, { method: 'POST', rawBody: file, headers: { 'Content-Type': /\.pdf$/i.test(file.name) ? 'application/pdf' : 'text/plain', 'X-File-Name': encodeURIComponent(file.name), 'X-Material-Title': encodeURIComponent(title), 'X-Material-Category': category } }),
  resetPassword: (id, password) => api(`/courses/${encodeURIComponent(id)}/password`, { method: 'PUT', body: { password } })
};
