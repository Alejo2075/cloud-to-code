import { z } from 'zod';

/** Version of every serialized public model in this package. Bump with a migration. */
export const SCHEMA_VERSION = '1';

export const IsoDateTime = z.iso.datetime({ offset: true });

export const NonEmpty = z.string().min(1);
