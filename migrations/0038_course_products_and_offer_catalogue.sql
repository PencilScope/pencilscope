PRAGMA foreign_keys = ON;

CREATE TABLE product_offer_course_items (
  product_offer_id TEXT NOT NULL REFERENCES product_offers(id) ON DELETE CASCADE,
  course_id TEXT NOT NULL REFERENCES courses(id),
  course_offering_id TEXT NOT NULL REFERENCES course_offerings(id),
  position INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  PRIMARY KEY (product_offer_id, course_offering_id)
);
CREATE INDEX product_offer_course_items_course_idx
  ON product_offer_course_items(course_id, product_offer_id);
CREATE INDEX product_offer_course_items_offering_idx
  ON product_offer_course_items(course_offering_id, product_offer_id);

ALTER TABLE orders ADD COLUMN product_offer_id TEXT REFERENCES product_offers(id);
CREATE INDEX orders_product_offer_idx ON orders(product_offer_id, student_user_id, status);
