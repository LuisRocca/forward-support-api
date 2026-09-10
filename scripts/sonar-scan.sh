#!/bin/sh
# Análisis de SonarQube en un contenedor (servidor del compose de calidad).
#
# Al contenedor del scanner, que es una imagen de terceros, solo le llega
# SONAR_TOKEN y no el .env entero: ahí están la password de la base y los
# secretos JWT. El token se pasa por variable de entorno y no como argumento,
# para que no aparezca en la lista de procesos del host.
#
# El repositorio se monta en solo lectura: el análisis no puede tocar el
# código. Por eso el directorio de trabajo del scanner va a /tmp del contenedor.
set -eu

SONAR_TOKEN=$(grep '^SONAR_TOKEN=' .env | cut -d= -f2-)
if [ -z "$SONAR_TOKEN" ]; then
  echo 'Falta SONAR_TOKEN en .env' >&2
  exit 1
fi
export SONAR_TOKEN

exec docker run --rm \
  --network forward-quality_default \
  -e SONAR_HOST_URL=http://sonarqube:9000 \
  -e SONAR_TOKEN \
  -v "$PWD:/usr/src:ro,z" \
  docker.io/sonarsource/sonar-scanner-cli \
  -Dsonar.working.directory=/tmp/.scannerwork
