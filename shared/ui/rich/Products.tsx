/**
 * ```products — shopping results as cards, and a side-by-side comparison when
 * the products carry specs.
 *
 * @module shared/ui/rich/Products
 */

import React from 'react';
import { Arriving, Carousel, ExtLink, Favicon, Icon, SafeImg, Stars, useParsed } from './common';
import { formatPrice, hostOf, parseProducts, specKeys, type Product, type ProductsSpec } from './specs';

export function Products({ source, streaming = false }: { source: string; streaming?: boolean }): React.ReactElement {
  const { spec, waiting } = useParsed(source, streaming, parseProducts);
  if (waiting || !spec) return <Arriving what="Products" />;
  return <ProductsView spec={spec} />;
}

function ProductsView({ spec }: { spec: ProductsSpec }): React.ReactElement {
  return (
    <div className="aw aw-products">
      {spec.title && <div className="aw-heading">{spec.title}</div>}
      <Carousel label={spec.title ?? 'Products'}>
        {spec.products.map(p => <ProductCard key={p.id} product={p} />)}
      </Carousel>
      {spec.compare && <Compare products={spec.products} />}
    </div>
  );
}

function ProductCard({ product: p }: { product: Product }): React.ReactElement {
  const price = formatPrice(p.price, p.currency);
  return (
    <ExtLink href={p.url} className="aw-product-card" title={p.url ? `${p.name} — open in a new tab` : p.name}>
      <div className="aw-product-img">
        <SafeImg src={p.image} alt="" fallback={<span className="aw-product-ph"><Icon name="tag" size={26} /></span>} />
        {p.badge && <span className="aw-badge">{p.badge}</span>}
      </div>
      <div className="aw-product-body">
        <div className="aw-product-name" title={p.name}>{p.name}</div>
        {price && <div className="aw-product-price">{price}</div>}
        <Stars rating={p.rating} reviews={p.reviews} compact />
        {p.store && (
          <div className="aw-product-store">
            <Favicon host={hostOf(p.url)} name={p.store} size={14} />
            <span className="aw-ellipsis">{p.store}</span>
          </div>
        )}
      </div>
    </ExtLink>
  );
}

function Compare({ products }: { products: Product[] }): React.ReactElement {
  const rows = specKeys(products);
  return (
    <div className="aw-compare-wrap">
      <table className="aw-compare">
        <thead>
          <tr>
            <th scope="col" className="aw-compare-corner">Compare</th>
            {products.map(p => (
              <th key={p.id} scope="col">
                <div className="aw-compare-head">
                  <SafeImg src={p.image} alt="" className="aw-compare-img" />
                  <ExtLink href={p.url} className="aw-compare-name">{p.name}</ExtLink>
                  {p.price !== undefined && <span className="aw-compare-price">{formatPrice(p.price, p.currency)}</span>}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {products.some(p => p.rating !== undefined) && (
            <tr>
              <th scope="row">Rating</th>
              {products.map(p => <td key={p.id}>{p.rating !== undefined ? <Stars rating={p.rating} reviews={p.reviews} compact /> : '—'}</td>)}
            </tr>
          )}
          {rows.map(k => (
            <tr key={k}>
              <th scope="row">{k}</th>
              {products.map(p => <td key={p.id}>{p.specs?.find(([key]) => key === k)?.[1] ?? '—'}</td>)}
            </tr>
          ))}
          {products.some(p => p.store) && (
            <tr>
              <th scope="row">Store</th>
              {products.map(p => <td key={p.id}>{p.store ?? '—'}</td>)}
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
