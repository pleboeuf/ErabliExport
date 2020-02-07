Exportateur de données pour ErabliCollecteur

 Un serveur web permet de télécharger les événements depuis un point précis dans le passé, et de recevoir les nouveaux événements dès qu'ils arrivent. Les événements sont analysé et stocké dans la base de données. Ces données sont affiché dans une page web au format csv et exporté a interval dans un fichier csv.

## 1. Install node modules

Assuming NPM is already installed:

    npm install

## 2. Create SQLite Database

    sqlite3 data/db.sqlite3 < data/schema.sql

## 3. Configure

    cp config.json.sample config.json

Fill config.json with database name

## 3. Run!

    node app

Then point your browser to http://localhost:3003/

## To run the tests:

    sudo npm install -g expresso
    expresso
