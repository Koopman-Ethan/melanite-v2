'use client'

import { useState, useTransition } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/components/ui/copy-button'
import { Field, Notice } from '@/components/ui/field'
import { AmountField, EmailField, PhoneField } from '@/components/ui/validated-field'

import { createPrepaidLink, type PrepaidState } from './actions'

export interface PickableClient {
  id: string
  name: string | null
  email: string | null
  phone: string | null
}

/** Selling a prepaid balance.
 *
 *  Two things here are the feature rather than decoration.
 *
 *  The client is chosen BEFORE the link is sent, not derived from whoever pays it. That is what
 *  makes a gift work: a mother can pay her daughter's link and the balance is the daughter's.
 *  Taking the beneficiary from the payment would put it on the wrong person every time.
 *
 *  The purchaser fields only appear once "someone else is paying" is ticked. Asking every
 *  provider for a purchaser on every sale, when almost all of these are a client paying for
 *  themselves, is three empty boxes that train people to skip the section.
 */
export function SellBalance({ clients }: { clients: PickableClient[] }) {
  const [open, setOpen] = useState(false)
  const [pending, startTransition] = useTransition()
  const [state, setState] = useState<PrepaidState>({})
  const [url, setUrl] = useState<string | null>(null)

  const [amount, setAmount] = useState('')
  const [clientId, setClientId] = useState('')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [isGift, setIsGift] = useState(false)
  const [purchaserName, setPurchaserName] = useState('')
  const [purchaserEmail, setPurchaserEmail] = useState('')

  const reset = () => {
    setAmount('')
    setClientId('')
    setName('')
    setEmail('')
    setPhone('')
    setIsGift(false)
    setPurchaserName('')
    setPurchaserEmail('')
    setState({})
  }

  const submit = () =>
    startTransition(async () => {
      const result = await createPrepaidLink({
        amount: Number(amount),
        clientId: clientId || null,
        clientName: clientId ? null : name,
        clientEmail: clientId ? null : email,
        clientPhone: clientId ? null : phone,
        purchaserName: isGift ? purchaserName : null,
        purchaserEmail: isGift ? purchaserEmail : null,
      })

      setState(result)
      if (result.url) {
        setUrl(result.url)
        setOpen(false)
        reset()
      }
    })

  const field =
    'w-full rounded-field border border-line-control bg-overlay px-3 py-2 text-sm text-ink'

  if (url) {
    return (
      <div className="rounded-card border border-gold/40 bg-gold/5 p-5">
        <p className="text-sm font-medium">Payment link ready</p>
        <p className="mt-1 text-xs text-ink-muted">
          Most of these go by text, so it is offered for copying rather than only emailed.
        </p>
        <p className="mt-3 break-all rounded-field border border-line-control bg-overlay px-3 py-2 font-mono text-xs">
          {url}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <CopyButton value={url} label="Copy" copiedLabel="Copied" />
          <Button size="sm" variant="ghost" onClick={() => setUrl(null)}>
            Done
          </Button>
        </div>
      </div>
    )
  }

  if (!open) {
    return (
      <Button size="sm" onClick={() => setOpen(true)}>
        Sell a prepaid balance
      </Button>
    )
  }

  return (
    <div className="space-y-4 rounded-card border border-line-strong bg-overlay/50 p-5">
      <h3 className="text-sm font-medium">Sell a prepaid balance</h3>

      {state.error && <Notice>{state.error}</Notice>}

      <AmountField
        id="prepaidAmount"
        label="Amount"
        value={amount}
        onChange={setAmount}
        hint="Any dollar amount. It can be spent on whatever they book later."
      />

      <div className="space-y-1.5 text-sm">
        <span className="block font-medium text-ink-secondary">Who is this balance for?</span>
        <select
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          className={field}
        >
          <option value="">Someone new…</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? c.email ?? 'Client'}
              {c.name && c.email ? ` · ${c.email}` : ''}
            </option>
          ))}
        </select>
      </div>

      {!clientId && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="clientName"
            label="Their name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
          <EmailField
            id="clientEmail"
            label="Their email"
            value={email}
            onChange={setEmail}
            hint="How the balance stays attached to a person."
          />
          <PhoneField
            id="clientPhone"
            label="Their phone"
            value={phone}
            onChange={setPhone}
            optional
          />
        </div>
      )}

      <label className="flex items-start gap-2 text-sm">
        <input
          type="checkbox"
          checked={isGift}
          onChange={(e) => setIsGift(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          <span className="font-medium text-ink-secondary">Someone else is paying for this</span>
          <span className="mt-0.5 block text-xs text-ink-faint">
            The balance still belongs to the person above. This only records who bought it.
          </span>
        </span>
      </label>

      {isGift && (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="purchaserName"
            label="Purchaser name"
            value={purchaserName}
            onChange={(e) => setPurchaserName(e.target.value)}
          />
          <EmailField
            id="purchaserEmail"
            label="Purchaser email"
            value={purchaserEmail}
            onChange={setPurchaserEmail}
            optional
          />
        </div>
      )}

      {/* Said at the point of sale, because it is the thing a client is most likely to ask
          about afterwards and the provider is the one who will be asked. */}
      <p className="text-xs text-ink-faint">
        A prepaid balance does not expire and is not refundable. Your share is paid out when it
        is bought, not when it is used.
      </p>

      <div className="flex gap-2">
        <Button size="sm" disabled={pending || !amount} onClick={submit}>
          {pending ? 'Creating…' : 'Create payment link'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() => {
            setOpen(false)
            reset()
          }}
        >
          Cancel
        </Button>
      </div>
    </div>
  )
}
