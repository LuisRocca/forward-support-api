// argon2id. Los parámetros vienen del entorno para poder subirlos sin tocar
// código cuando el hardware lo permita.
import { Injectable } from '@nestjs/common';
import argon2 from 'argon2';

import { EnvService } from '../config/env.js';

@Injectable()
export class PasswordService {
  constructor(private readonly env: EnvService) {}

  async hash(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: this.env.argonMemoryCost,
      timeCost: 2,
      parallelism: 1,
    });
  }

  /**
   * Devuelve false ante un hash corrupto o con formato desconocido en vez de
   * propagar: los usuarios del seed llevan un marcador y no un hash real, y
   * eso tiene que resolverse como "credenciales inválidas", no como un 500.
   */
  async verificar(hash: string, password: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }
}
