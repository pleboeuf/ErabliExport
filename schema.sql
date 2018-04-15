CREATE TABLE pumps (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   temps_mesure datetime,
   event_type varchar(8),
   pump_state integer
);
CREATE TABLE tanks (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   temps_mesure datetime,
   fill_gallons integer,
   fill_percent float
);
CREATE TABLE valves (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   temps_mesure datetime,
   valve_name text,
   position varchar(8),
   position_code integer
);
CREATE TABLE vacuum (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   temps_mesure datetime,
   mm_hg float
);
CREATE TABLE linevacuum (
   device_id varchar(24),
   device_name varchar(24),
   published_at timestamp,
   temps_mesure datetime,
   line_name varchar(24),
   mm_hg float,
   temp float,
   light integer,
   soc float,
   volt float,
   rssi integer,
   qual integer,
   Vin float
);
CREATE TABLE cycles (
   device_id varchar(24),
   device_name varchar(24),
   end_time timestamp,
   fin_cycle datetime,
   pump_on_time float,
   volume float,
   volume_total float,
   dutycycle float,
   rate float
);
CREATE TABLE coulee (
   device_id varchar(24),
   device_name varchar(24),
   start_stop_time timestamp,
   temps_debut_fin datetime,
   event_type varchar(8),
   volume float,
   volume_total float
);
