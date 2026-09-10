import { Global, Module } from '@nestjs/common';
import { ConfigModule as NestConfigModule } from '@nestjs/config';
import { EnvService } from './env.js';

@Global()
@Module({
  imports: [NestConfigModule.forRoot({ isGlobal: true, cache: true })],
  providers: [EnvService],
  exports: [EnvService],
})
export class ConfigModule {}
