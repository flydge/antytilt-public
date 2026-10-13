import { config as loadEnvironment } from 'dotenv'

if (process.env.NODE_ENV !== 'test') loadEnvironment()
