CREATE TABLE pumps (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   event_type varchar(8)
);
CREATE TABLE tanks (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   fill_gallons integer,
   fill_percent float
);
CREATE TABLE valves (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   event_type varchar(8)
);
CREATE TABLE vacuum (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   mm_hg float
);
