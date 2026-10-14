export const learningProductDataReadySql = (productAlias: string): string => `(
  LENGTH(TRIM(${productAlias}.title)) >= 3
  AND LENGTH(TRIM(${productAlias}.description)) >= 20
  AND LENGTH(TRIM(${productAlias}.subject)) > 0
  AND LENGTH(TRIM(${productAlias}.audience)) > 0
  AND ${productAlias}.estimated_minutes BETWEEN 1 AND 10000
  AND (
    (${productAlias}.product_type IN ('quiz', 'test', 'mock_exam')
      AND JSON_VALID(${productAlias}.content_json)
      AND JSON_ARRAY_LENGTH(JSON_EXTRACT(${productAlias}.content_json, '$.questions')) > 0)
    OR (${productAlias}.product_type NOT IN ('quiz', 'test', 'mock_exam')
      AND (${productAlias}.content_url LIKE 'https://%' OR ${productAlias}.content_url LIKE 'http://%'))
  )
)`;

export const offeringContentCountSql = (offeringAlias: string): string => `(
  (SELECT COUNT(*) FROM course_offering_modules WHERE course_offering_id = ${offeringAlias}.id)
  + (SELECT COUNT(*) FROM course_offering_materials WHERE course_offering_id = ${offeringAlias}.id)
  + (SELECT COUNT(*) FROM course_offering_assessments WHERE course_offering_id = ${offeringAlias}.id)
  + (SELECT COUNT(*) FROM course_offering_flashcard_decks WHERE course_offering_id = ${offeringAlias}.id)
  + (SELECT COUNT(*) FROM course_offering_learning_products WHERE course_offering_id = ${offeringAlias}.id)
  + (SELECT COUNT(*) FROM course_sessions WHERE course_offering_id = ${offeringAlias}.id AND status != 'cancelled')
)`;

export const offeringProductsReadySql = (offeringAlias: string): string => `NOT EXISTS (
  SELECT 1 FROM course_offering_learning_products readiness_olp
  JOIN learning_products readiness_p ON readiness_p.id = readiness_olp.learning_product_id
  WHERE readiness_olp.course_offering_id = ${offeringAlias}.id
    AND (
      readiness_p.status != 'published'
      OR readiness_p.listing_status != 'listed'
      OR NOT ${learningProductDataReadySql('readiness_p')}
  )
)
AND NOT EXISTS (
  SELECT 1 FROM course_offering_modules readiness_om
  JOIN course_modules readiness_m ON readiness_m.id = readiness_om.module_id
  WHERE readiness_om.course_offering_id = ${offeringAlias}.id
    AND (LENGTH(TRIM(readiness_m.title)) < 3 OR NOT EXISTS (
      SELECT 1 FROM lessons readiness_l
      WHERE readiness_l.module_id = readiness_m.id
        AND LENGTH(TRIM(readiness_l.title)) >= 3
        AND readiness_l.estimated_minutes > 0
        AND JSON_VALID(readiness_l.content_json)
    ))
)
AND NOT EXISTS (
  SELECT 1 FROM course_offering_materials readiness_mt
  JOIN course_materials readiness_material ON readiness_material.id = readiness_mt.material_id
  WHERE readiness_mt.course_offering_id = ${offeringAlias}.id
    AND (readiness_material.status != 'published'
      OR LENGTH(TRIM(readiness_material.title)) < 3
      OR (readiness_material.storage_key IS NULL AND readiness_material.external_url IS NULL))
)
AND NOT EXISTS (
  SELECT 1 FROM course_offering_assessments readiness_oa
  JOIN assessments readiness_a ON readiness_a.id = readiness_oa.assessment_id
  WHERE readiness_oa.course_offering_id = ${offeringAlias}.id
    AND (readiness_a.status != 'published'
      OR LENGTH(TRIM(readiness_a.title)) < 3
      OR NOT EXISTS (SELECT 1 FROM assessment_questions readiness_q
        WHERE readiness_q.assessment_id = readiness_a.id AND LENGTH(TRIM(readiness_q.prompt)) > 0))
)
AND NOT EXISTS (
  SELECT 1 FROM course_offering_flashcard_decks readiness_od
  JOIN flashcard_decks readiness_d ON readiness_d.id = readiness_od.deck_id
  WHERE readiness_od.course_offering_id = ${offeringAlias}.id
    AND (readiness_d.status != 'published'
      OR LENGTH(TRIM(readiness_d.title)) < 3
      OR NOT EXISTS (SELECT 1 FROM flashcards readiness_f
        WHERE readiness_f.deck_id = readiness_d.id
          AND LENGTH(TRIM(readiness_f.front_text)) > 0 AND LENGTH(TRIM(readiness_f.back_text)) > 0))
)`;

export const offeringCommerceReadySql = (offeringAlias: string): string => `(
  ${offeringAlias}.status = 'published'
  AND ${offeringAlias}.pricing_status = 'ready'
  AND ${offeringAlias}.stripe_price_id IS NOT NULL
  AND ${offeringAlias}.price_cents >= 50
  AND ${offeringContentCountSql(offeringAlias)} >= 1
  AND ${offeringProductsReadySql(offeringAlias)}
)`;
