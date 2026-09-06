# Deploying __APP_TITLE__

A page app has no server of its own: aico's apps host serves `public/` and
provides the database API. It runs wherever aico runs — on this machine, or on a
machine running `aico serve` that others reach over the network.

There is no Docker target because there is nothing to containerise separately.
When the tool needs to live on its own — public users, its own domain, its own
auth — create an app from `web-saas-next`, copy the tables from `schema.sql`
into its migrations, and rebuild the screen in React. The data model carries
over unchanged.
