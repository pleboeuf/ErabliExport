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
CREATE TABLE cycles (
   device_id varchar(24),
   device_name varchar(24),
   end_time timestamp,
   pump_on_time float,
   volume float,
   dutycycle float,
   rate float
);
CREATE TABLE coulee (
   device_id varchar(24),
   device_name varchar(24),
   start_stop_time timestamp,
   event_type varchar(8),
   volume float
);
