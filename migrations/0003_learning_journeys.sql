PRAGMA foreign_keys = ON;

CREATE TABLE user_credentials (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_iterations INTEGER NOT NULL DEFAULT 210000,
  email_verified_at TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE student_profiles (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  primary_level TEXT,
  managed_by_parent INTEGER NOT NULL DEFAULT 1 CHECK (managed_by_parent IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE assessments (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  assessment_type TEXT NOT NULL CHECK (assessment_type IN ('quiz', 'test', 'mock_exam')),
  title TEXT NOT NULL,
  instructions TEXT NOT NULL DEFAULT '',
  time_limit_seconds INTEGER,
  attempt_limit INTEGER,
  passing_score INTEGER NOT NULL DEFAULT 50 CHECK (passing_score BETWEEN 0 AND 100),
  feedback_mode TEXT NOT NULL DEFAULT 'immediate' CHECK (feedback_mode IN ('immediate', 'after_submission', 'after_close')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'closed', 'archived')),
  version INTEGER NOT NULL DEFAULT 1,
  available_from TEXT,
  available_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX assessments_course_idx ON assessments(course_id, status, assessment_type);

CREATE TABLE assessment_questions (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id) ON DELETE CASCADE,
  question_type TEXT NOT NULL CHECK (question_type IN ('multiple_choice', 'true_false', 'short_text')),
  prompt TEXT NOT NULL,
  explanation TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL DEFAULT 1 CHECK (points > 0),
  position INTEGER NOT NULL,
  UNIQUE(assessment_id, position)
);

CREATE TABLE assessment_options (
  id TEXT PRIMARY KEY,
  question_id TEXT NOT NULL REFERENCES assessment_questions(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  is_correct INTEGER NOT NULL DEFAULT 0 CHECK (is_correct IN (0, 1)),
  position INTEGER NOT NULL,
  UNIQUE(question_id, position)
);

CREATE TABLE assessment_attempts (
  id TEXT PRIMARY KEY,
  assessment_id TEXT NOT NULL REFERENCES assessments(id),
  assessment_version INTEGER NOT NULL,
  enrolment_id TEXT NOT NULL REFERENCES enrolments(id) ON DELETE CASCADE,
  student_user_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'in_progress'
    CHECK (status IN ('in_progress', 'submitted', 'grading', 'graded', 'expired')),
  started_at TEXT NOT NULL,
  expires_at TEXT,
  submitted_at TEXT,
  graded_at TEXT,
  score INTEGER,
  max_score INTEGER,
  passed INTEGER CHECK (passed IN (0, 1)),
  UNIQUE(assessment_id, student_user_id, started_at)
);
CREATE INDEX assessment_attempts_student_idx ON assessment_attempts(student_user_id, status, started_at);

CREATE TABLE assessment_responses (
  attempt_id TEXT NOT NULL REFERENCES assessment_attempts(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES assessment_questions(id),
  selected_option_id TEXT REFERENCES assessment_options(id),
  text_response TEXT,
  awarded_points INTEGER,
  is_correct INTEGER CHECK (is_correct IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (attempt_id, question_id)
);

CREATE TABLE flashcard_decks (
  id TEXT PRIMARY KEY,
  course_id TEXT NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  lesson_id TEXT REFERENCES lessons(id) ON DELETE SET NULL,
  created_by TEXT NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'archived')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE flashcards (
  id TEXT PRIMARY KEY,
  deck_id TEXT NOT NULL REFERENCES flashcard_decks(id) ON DELETE CASCADE,
  front_text TEXT NOT NULL,
  back_text TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(deck_id, position)
);

CREATE TABLE flashcard_reviews (
  student_user_id TEXT NOT NULL REFERENCES users(id),
  flashcard_id TEXT NOT NULL REFERENCES flashcards(id) ON DELETE CASCADE,
  confidence INTEGER NOT NULL CHECK (confidence BETWEEN 1 AND 4),
  repetition_count INTEGER NOT NULL DEFAULT 0,
  interval_days INTEGER NOT NULL DEFAULT 0,
  next_review_at TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (student_user_id, flashcard_id)
);
CREATE INDEX flashcard_reviews_due_idx ON flashcard_reviews(student_user_id, next_review_at);

INSERT OR IGNORE INTO course_modules (id, course_id, title, position, created_at) VALUES
  ('module-maths-foundations', 'course-maths-5', 'Problem-solving foundations', 1, datetime('now')),
  ('module-science-foundations', 'course-science-4', 'Scientific thinking', 1, datetime('now')),
  ('module-english-foundations', 'course-english-3', 'Confident communication', 1, datetime('now'));

INSERT OR IGNORE INTO lessons
  (id, module_id, title, lesson_type, content_json, position, estimated_minutes, created_at, updated_at)
VALUES
  ('lesson-maths-video', 'module-maths-foundations', 'Visual models for word problems', 'video',
   '{"summary":"Learn how bar models turn word problems into clear visual steps."}', 1, 20, datetime('now'), datetime('now')),
  ('lesson-maths-quiz', 'module-maths-foundations', 'Check your understanding', 'quiz',
   '{"summary":"A short practice quiz on visual models."}', 2, 10, datetime('now'), datetime('now')),
  ('lesson-maths-test', 'module-maths-foundations', 'Topic test', 'quiz',
   '{"summary":"A timed test covering the module."}', 3, 25, datetime('now'), datetime('now')),
  ('lesson-maths-mock', 'module-maths-foundations', 'Mock examination', 'quiz',
   '{"summary":"Practise under examination conditions."}', 4, 45, datetime('now'), datetime('now')),
  ('lesson-science-text', 'module-science-foundations', 'Observe, explain, conclude', 'text',
   '{"summary":"Build clear scientific explanations from observations."}', 1, 20, datetime('now'), datetime('now')),
  ('lesson-english-text', 'module-english-foundations', 'Speaking with confidence', 'text',
   '{"summary":"Use structure and expression to share ideas clearly."}', 1, 20, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO assessments
  (id, course_id, lesson_id, created_by, assessment_type, title, instructions,
   time_limit_seconds, attempt_limit, passing_score, feedback_mode, status, version, created_at, updated_at)
VALUES
  ('assessment-maths-quiz', 'course-maths-5', 'lesson-maths-quiz', 'tutor-tan', 'quiz',
   'Visual models quiz', 'Choose the best answer for each question.', NULL, 3, 60, 'immediate', 'published', 1, datetime('now'), datetime('now')),
  ('assessment-maths-test', 'course-maths-5', 'lesson-maths-test', 'tutor-tan', 'test',
   'Problem-solving topic test', 'Complete every question before submitting.', 1500, 2, 60, 'after_submission', 'published', 1, datetime('now'), datetime('now')),
  ('assessment-maths-mock', 'course-maths-5', 'lesson-maths-mock', 'tutor-tan', 'mock_exam',
   'Primary 5 Mathematics mock examination', 'Work independently and submit before time expires.', 2700, 1, 50, 'after_submission', 'published', 1, datetime('now'), datetime('now'));

INSERT OR IGNORE INTO assessment_questions
  (id, assessment_id, question_type, prompt, explanation, points, position)
VALUES
  ('question-quiz-1', 'assessment-maths-quiz', 'multiple_choice',
   'A box contains 24 pencils shared equally among 6 students. How many pencils does each student receive?',
   'Divide the total number of pencils by the number of students: 24 � 6 = 4.', 1, 1),
  ('question-test-1', 'assessment-maths-test', 'multiple_choice',
   'Which operation finds the value of one equal group?', 'Division finds the value of one equal group.', 2, 1),
  ('question-mock-1', 'assessment-maths-mock', 'multiple_choice',
   'A ribbon 120 cm long is cut into 5 equal pieces. What is the length of each piece?',
   '120 � 5 = 24 cm.', 2, 1);

INSERT OR IGNORE INTO assessment_options (id, question_id, label, is_correct, position) VALUES
  ('option-quiz-1-a', 'question-quiz-1', '3', 0, 1),
  ('option-quiz-1-b', 'question-quiz-1', '4', 1, 2),
  ('option-quiz-1-c', 'question-quiz-1', '6', 0, 3),
  ('option-test-1-a', 'question-test-1', 'Addition', 0, 1),
  ('option-test-1-b', 'question-test-1', 'Multiplication', 0, 2),
  ('option-test-1-c', 'question-test-1', 'Division', 1, 3),
  ('option-mock-1-a', 'question-mock-1', '20 cm', 0, 1),
  ('option-mock-1-b', 'question-mock-1', '24 cm', 1, 2),
  ('option-mock-1-c', 'question-mock-1', '25 cm', 0, 3);

INSERT OR IGNORE INTO flashcard_decks
  (id, course_id, lesson_id, created_by, title, description, status, created_at, updated_at)
VALUES
  ('deck-maths-models', 'course-maths-5', 'lesson-maths-video', 'tutor-tan',
   'Visual model essentials', 'Review the language and operations used in word problems.', 'published', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO flashcards
  (id, deck_id, front_text, back_text, position, created_at, updated_at)
VALUES
  ('card-maths-total', 'deck-maths-models', 'What does in total usually suggest?', 'Addition', 1, datetime('now'), datetime('now')),
  ('card-maths-equal', 'deck-maths-models', 'What operation finds one equal share?', 'Division', 2, datetime('now'), datetime('now')),
  ('card-maths-difference', 'deck-maths-models', 'What operation finds the difference?', 'Subtraction', 3, datetime('now'), datetime('now'));
