import type { ComponentProps } from 'react';
import { ChevronDown } from 'lucide-react';

export function NativeSelect(props: ComponentProps<'select'>) {
  return <div className="native-select"><select {...props} /><ChevronDown aria-hidden="true" /></div>;
}
