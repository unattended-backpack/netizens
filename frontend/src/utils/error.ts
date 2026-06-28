import { UserRejectedRequestError } from 'viem';

/** Patterns that indicate user rejection of a transaction */
const REJECTION_PATTERNS = [
  'UserRejectedRequestError',
  'user rejected',
  'user denied',
  'rejected by user',
];

/**
 * Recursively check if an error chain contains a UserRejectedRequestError.
 * Handles nested error causes from wallet rejections.
 * @param err - The error to check
 * @param depth - Current recursion depth (internal use)
 */
export const hasUserRejection = (err: unknown, depth = 0): boolean => {
  // Prevent stack overflow from circular references
  if (depth > 10) return false;

  if (err instanceof UserRejectedRequestError) return true;

  // Check error message against rejection patterns
  if (err && typeof err === 'object' && 'message' in err) {
    const message = String((err as { message: unknown }).message).toLowerCase();
    if (REJECTION_PATTERNS.some(pattern => message.includes(pattern.toLowerCase()))) {
      return true;
    }
  }

  if (err && typeof err === 'object' && 'cause' in err) {
    return hasUserRejection((err as { cause: unknown }).cause, depth + 1);
  }
  return false;
};
