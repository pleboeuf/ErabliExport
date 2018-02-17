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
   pump_name varchar(24),
   end_time timestamp,
   on_duration float,
   volume float,
   dutycycle float,
   rate float
);
CREATE TABLE Coulee (
   device_name varchar(24),
   no_coulee integer,
   start_time timestamp,
   end_time float
);
