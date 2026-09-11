#!/bin/sh
# Lanza una tarea puntual (migraciones o seed) con la red del servicio, espera a
# que termine y sale con su código de salida.
#   sh scripts/run-task.sh MigrateTaskArn | SeedTaskArn
set -eu

STACK=ForwardStack
REGION=us-east-1
TASK_OUTPUT=${1:?Uso: run-task.sh MigrateTaskArn|SeedTaskArn}

output() {
  aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK" \
    --query "Stacks[0].Outputs[?OutputKey=='$1'].OutputValue" --output text
}

CLUSTER=$(output ClusterName)
TASK_DEF=$(output "$TASK_OUTPUT")
SUBNETS=$(output TaskSubnets)
SG=$(output TaskSecurityGroup)

TASK_ARN=$(aws ecs run-task --region "$REGION" --cluster "$CLUSTER" \
  --task-definition "$TASK_DEF" --launch-type FARGATE \
  --network-configuration "awsvpcConfiguration={subnets=[$SUBNETS],securityGroups=[$SG],assignPublicIp=ENABLED}" \
  --query 'tasks[0].taskArn' --output text)

echo "Tarea lanzada: $TASK_ARN"
echo "Esperando a que termine (el seed completo tarda varios minutos)..."
# tasks-stopped se rinde a los 10 min: se reintenta hasta que pare de verdad.
until aws ecs wait tasks-stopped --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" 2>/dev/null; do :; done

EXIT_CODE=$(aws ecs describe-tasks --region "$REGION" --cluster "$CLUSTER" --tasks "$TASK_ARN" \
  --query 'tasks[0].containers[0].exitCode' --output text)
echo "Código de salida: $EXIT_CODE (logs en CloudWatch, grupo *$TASK_OUTPUT*)"
[ "$EXIT_CODE" = "0" ]
