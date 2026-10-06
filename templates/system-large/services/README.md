# services

Put the medium tier's `services/api` (Spring Modulith, image `system-api`) and `services/web`
(React and nginx, image `system-web`) here. The large tier deploys those two images; it does not copy
their source, so there is one copy of the application to maintain. Build and push:

```sh
docker build -t ghcr.io/example-org/system-api:0.1.0 services/api
docker build -t ghcr.io/example-org/system-web:0.1.0 services/web
```

and set the digests in `deploy/helm/system/values-<env>.yaml` (production refuses tag-only images).
