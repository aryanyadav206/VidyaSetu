import { CONTENT_CATEGORIES } from '../../shared/categories';
import { useState } from 'react';

function RemoveControl({ title, onConfirm, busy }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? <div className="remove-confirm" role="group" aria-label={`Confirm removal of ${title}`}><span>Remove this material permanently?</span><button type="button" className="button remove-button" disabled={busy} onClick={onConfirm}>{busy ? 'Removing…' : 'Confirm remove'}</button><button type="button" className="button secondary" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div> : <button type="button" className="button remove-button" disabled={busy} aria-label={`Remove ${title}`} onClick={() => setConfirming(true)}>Remove</button>;
}

export default function CourseContent({ courseId, materials = [], lessons = [], canRemove = false, onRemove, busy = false }) {
  return <section aria-label="Course content">
    <h2>Course content <span className="count">{materials.length + lessons.length}</span></h2>
    <div className="content-sections">
      {CONTENT_CATEGORIES.map(category => {
        const files = materials.filter(material => (material.category || 'notes') === category.value);
        const textLessons = category.value === 'notes' ? lessons : [];
        const count = files.length + textLessons.length;
        return <section className={`content-category category-${category.value}`} key={category.value} aria-labelledby={`category-${category.value}`}>
          <div className="category-heading"><div><h3 id={`category-${category.value}`}>{category.label}<span className="count">{count}</span></h3><p>{category.description}</p></div></div>
          {!count && <p className="category-empty">No {category.label.toLowerCase()} uploaded yet.</p>}
          {files.map(material => <article className="material-card" key={material.id}>
            <span className="material-type">{material.contentType === 'application/pdf' ? 'PDF' : 'TEXT'}</span>
            <div><h3>{material.title}</h3><p>{material.filename} · {material.size < 1024 * 1024 ? `${Math.ceil(material.size / 1024)} KB` : `${(material.size / 1024 / 1024).toFixed(1)} MB`}</p></div>
            <div className="material-actions"><a className="button secondary" href={`/api/courses/${encodeURIComponent(courseId)}/materials/${encodeURIComponent(material.id)}`} download>Download</a>{canRemove && <RemoveControl title={material.title} busy={busy} onConfirm={() => onRemove(material.id, 'materials')}/>}</div>
          </article>)}
          {textLessons.map((lesson, index) => <details className="lesson" key={lesson.id}><summary><span className="lesson-num">{String(index + 1).padStart(2, '0')}</span>{lesson.title}<span className="lesson-open">+</span></summary><p>{lesson.body}</p>{canRemove && <div className="lesson-actions"><RemoveControl title={lesson.title} busy={busy} onConfirm={() => onRemove(lesson.id, 'lessons')}/></div>}</details>)}
        </section>;
      })}
    </div>
  </section>;
}
