import React from "react"

import notFoundStyle from "../styles/404.scss"
import { QuartzComponent, QuartzComponentConstructor } from "../types"

const NotFound: QuartzComponent = () => {
  return (
    <article className="popover-hint">
      <div id="not-found-div">
        <div>
          <h1>404</h1>
          <p>
            That page doesn’t exist. <br />
            But don’t leave! <br />
          </p>
        </div>

      
      </div>
    </article>
  )
}
NotFound.css = notFoundStyle

export default (() => NotFound) satisfies QuartzComponentConstructor
