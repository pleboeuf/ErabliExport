CREATE TABLE pumps (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   published_at TIMESTAMP,
   dev_timer INTEGER,
   temps_mesure datetime,
   event_type VARCHAR(8),
   pump_state INTEGER
);
CREATE TABLE tanks (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   published_at timestamp,
   temps_mesure datetime,
   fill_gallons INTEGER,
   fill_percent FLOAT
);
CREATE TABLE valves (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   published_at timestamp,
   valve_name text,
   temps_mesure datetime,
   position VARCHAR(8),
   position_code INTEGER
);
CREATE TABLE vacuum (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   published_at timestamp,
   temps_mesure datetime,
   mm_hg FLOAT
);
CREATE TABLE linevacuum (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   published_at timestamp,
   line_name VARCHAR(24),
   temps_mesure datetime,
   mm_hg FLOAT,
   temp FLOAT,
   light INTEGER,
   soc FLOAT,
   volt FLOAT,
   rssi INTEGER,
   qual INTEGER,
   Vin FLOAT
);
CREATE TABLE cycles (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   end_time timestamp,
   fin_cycle datetime,
   volume FLOAT,
   rate FLOAT,
   dutycycle FLOAT,
   pump_on_time FLOAT,
   pump_off_time FLOAT,
   volume_total FLOAT
);
CREATE TABLE coulee (
   device_id VARCHAR(24),
   device_name VARCHAR(24),
   start_stop_time timestamp,
   temps_debut_fin datetime,
   event_type VARCHAR(8),
   volume_total FLOAT
);
